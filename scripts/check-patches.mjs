#!/usr/bin/env node

/**
 * Patch Checker — scans all application manifests for newer patch versions
 * available on Docker Hub or GHCR within the same major.minor series.
 *
 * Usage:
 *   node scripts/check-patches.mjs              # Dry run — print available patches
 *   node scripts/check-patches.mjs --apply      # Update manifest.json files in-place
 *
 * Exit code 0 = no patches found, 1 = patches found (or applied)
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const SKIP_DIRS = new Set(['.git', '.github', 'node_modules', 'schema', 'scripts']);

// ─── Registry API helpers ───────────────────────────────────────────────────

/**
 * Fetch tags from Docker Hub for a library or namespaced image.
 * Returns array of tag strings.
 */
async function fetchDockerHubTags(image) {
  const parts = image.split('/');
  let repo;
  if (parts.length === 1) {
    repo = `library/${parts[0]}`;
  } else if (parts.length === 2) {
    repo = `${parts[0]}/${parts[1]}`;
  } else {
    return []; // GHCR or other registries handled separately
  }

  const url = `https://hub.docker.com/v2/repositories/${repo}/tags/?page_size=100&ordering=last_updated`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results || []).map((t) => t.name);
  } catch {
    return [];
  }
}

/**
 * Fetch tags from GHCR (GitHub Container Registry).
 */
async function fetchGhcrTags(image) {
  // image format: ghcr.io/owner/name
  const match = image.match(/^ghcr\.io\/(.+)$/);
  if (!match) return [];

  const packagePath = match[1];
  const url = `https://ghcr.io/v2/${packagePath}/tags/list`;
  try {
    // GHCR requires a token even for public images
    const tokenRes = await fetch(
      `https://ghcr.io/token?scope=repository:${packagePath}:pull`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!tokenRes.ok) return [];
    const { token } = await tokenRes.json();

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.tags || [];
  } catch {
    return [];
  }
}

/**
 * Fetch tags from lscr.io (LinuxServer Container Registry — backed by GHCR).
 */
async function fetchLscrTags(image) {
  // lscr.io/linuxserver/bookstack → ghcr.io/linuxserver/bookstack
  const ghcrImage = image.replace('lscr.io/', 'ghcr.io/');
  return fetchGhcrTags(ghcrImage);
}

/**
 * Fetch available tags for an image from its registry.
 */
async function fetchTags(imageName) {
  if (imageName.startsWith('ghcr.io/')) {
    return fetchGhcrTags(imageName);
  }
  if (imageName.startsWith('lscr.io/')) {
    return fetchLscrTags(imageName);
  }
  // Default: Docker Hub
  return fetchDockerHubTags(imageName);
}

// ─── Version parsing ────────────────────────────────────────────────────────

/**
 * Parse an image reference into { registry, name, tag, suffix }.
 * e.g., "wordpress:6.9-php8.4-apache" → { name: "wordpress", tag: "6.9", suffix: "-php8.4-apache" }
 * e.g., "ghcr.io/immich-app/immich-server:v2.6.3" → { name: "ghcr.io/immich-app/immich-server", tag: "v2.6.3", suffix: "" }
 */
function parseImage(imageRef) {
  const colonIdx = imageRef.lastIndexOf(':');
  if (colonIdx === -1) return null;

  const name = imageRef.slice(0, colonIdx);
  const fullTag = imageRef.slice(colonIdx + 1);

  // Extract the version part and suffix
  // Match patterns like: "6.9-php8.4-apache", "v2.6.3", "17-alpine", "stable-10741"
  const versionMatch = fullTag.match(/^(v?\d+(?:\.\d+)*(?:\.\d+)?)(.*)?$/);
  if (!versionMatch) return null;

  return {
    name,
    fullTag,
    version: versionMatch[1],
    suffix: versionMatch[2] || '',
  };
}

/**
 * Parse a semver-ish version string into numeric parts.
 * "6.9" → [6, 9], "v2.6.3" → [2, 6, 3], "1.35.4" → [1, 35, 4]
 */
function parseVersion(version) {
  const clean = version.replace(/^v/, '');
  const parts = clean.split('.').map(Number);
  if (parts.some(isNaN)) return null;
  return parts;
}

/**
 * Compare two version arrays. Returns >0 if a > b, <0 if a < b, 0 if equal.
 */
function compareVersions(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const va = a[i] ?? 0;
    const vb = b[i] ?? 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}

/**
 * Given a current image tag and available tags, find the latest patch.
 * A "patch" is a newer version with the same major.minor prefix and same suffix.
 */
function findLatestPatch(currentImage, availableTags) {
  const parsed = parseImage(currentImage);
  if (!parsed) return null;

  const currentParts = parseVersion(parsed.version);
  if (!currentParts || currentParts.length < 2) return null;

  const prefix = parsed.version.startsWith('v') ? 'v' : '';
  const majorMinor = currentParts.slice(0, 2);

  let bestTag = null;
  let bestParts = currentParts;

  for (const tag of availableTags) {
    // Must have same suffix
    if (!tag.endsWith(parsed.suffix)) continue;

    const tagVersion = parsed.suffix ? tag.slice(0, -parsed.suffix.length) : tag;
    const tagParts = parseVersion(tagVersion);
    if (!tagParts || tagParts.length < 2) continue;

    // Must share same major.minor
    if (tagParts[0] !== majorMinor[0] || tagParts[1] !== majorMinor[1]) continue;

    // Must have the right prefix (v or not)
    const hasV = tagVersion.startsWith('v');
    if ((prefix === 'v') !== hasV) continue;

    // Must be newer
    if (compareVersions(tagParts, bestParts) > 0) {
      bestParts = tagParts;
      bestTag = tag;
    }
  }

  if (!bestTag || bestTag === parsed.fullTag) return null;

  return {
    currentTag: parsed.fullTag,
    newTag: bestTag,
    currentVersion: parsed.version,
    newVersion: prefix + bestParts.join('.'),
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const dirs = readdirSync(ROOT).filter((name) => {
    const full = join(ROOT, name);
    return statSync(full).isDirectory() && !name.startsWith('.') && !SKIP_DIRS.has(name);
  });

  let patchesFound = 0;
  const results = [];

  for (const dir of dirs) {
    const manifestPath = join(ROOT, dir, 'manifest.json');
    if (!existsSync(manifestPath)) continue;

    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      continue;
    }

    const updates = [];

    // Check each component image
    for (const comp of manifest.components) {
      const parsed = parseImage(comp.image);
      if (!parsed) continue;

      // Skip infrastructure images (shared across apps, update separately)
      const infraPrefixes = ['mariadb', 'postgres', 'redis', 'mongo', 'clickhouse/', 'node:', 'tensorchord/'];
      const isInfra = infraPrefixes.some((p) =>
        parsed.name === p.replace(':', '') || parsed.name.startsWith(p) || comp.image.startsWith(p),
      );
      if (isInfra) continue;

      console.log(`  Checking ${comp.image}...`);
      const tags = await fetchTags(parsed.name);
      if (tags.length === 0) {
        console.log(`    ⚠ Could not fetch tags for ${parsed.name}`);
        continue;
      }

      const patch = findLatestPatch(comp.image, tags);
      if (patch) {
        updates.push({ component: comp.name, ...patch, image: `${parsed.name}:${patch.newTag}` });
      }
    }

    // Also check supportedVersions component images
    if (manifest.supportedVersions) {
      for (const sv of manifest.supportedVersions) {
        for (const comp of sv.components) {
          const parsed = parseImage(comp.image);
          if (!parsed) continue;

          const tags = await fetchTags(parsed.name);
          const patch = findLatestPatch(comp.image, tags);
          if (patch) {
            updates.push({
              component: `${sv.version}/${comp.name}`,
              ...patch,
              image: `${parsed.name}:${patch.newTag}`,
              inSupportedVersions: true,
              versionEntry: sv.version,
              componentName: comp.name,
            });
          }
        }
      }
    }

    if (updates.length > 0) {
      patchesFound += updates.length;
      results.push({ app: dir, updates });

      console.log(`\n📦 ${manifest.name} (${dir}):`);
      for (const u of updates) {
        console.log(`  ${u.component}: ${u.currentTag} → ${u.newTag}`);
      }

      if (APPLY) {
        let content = readFileSync(manifestPath, 'utf8');
        for (const u of updates) {
          const oldImage = `${u.currentTag}`;
          const newImage = `${u.newTag}`;
          // Replace the specific image tag in the JSON
          content = content.replaceAll(`"${parsed?.name ?? ''}:${oldImage}"`, `"${parsed?.name ?? ''}:${newImage}"`);
        }
        // Safer approach: re-parse, modify, re-serialize
        const updated = JSON.parse(readFileSync(manifestPath, 'utf8'));
        for (const u of updates) {
          if (u.inSupportedVersions) {
            const sv = updated.supportedVersions?.find((v) => v.version === u.versionEntry);
            if (sv) {
              const comp = sv.components.find((c) => c.name === u.componentName);
              if (comp) comp.image = u.image;
            }
          } else {
            const comp = updated.components.find((c) => c.name === u.component);
            if (comp) comp.image = u.image;
          }
        }
        writeFileSync(manifestPath, JSON.stringify(updated, null, 4) + '\n');
        console.log(`  ✓ Updated ${manifestPath}`);
      }
    }
  }

  console.log(`\n${'─'.repeat(50)}`);
  if (patchesFound > 0) {
    console.log(`\n🔄 ${patchesFound} patch(es) available across ${results.length} app(s)`);
    if (!APPLY) {
      console.log('  Run with --apply to update manifest files');
    }
    // Write summary for GitHub Actions
    if (process.env.GITHUB_OUTPUT) {
      const { appendFileSync } = await import('node:fs');
      appendFileSync(process.env.GITHUB_OUTPUT, `patches_found=true\n`);
      appendFileSync(process.env.GITHUB_OUTPUT, `patch_count=${patchesFound}\n`);
      const summary = results.map((r) =>
        r.updates.map((u) => `${r.app}: ${u.currentTag} → ${u.newTag}`).join(', ')
      ).join('; ');
      appendFileSync(process.env.GITHUB_OUTPUT, `patch_summary=${summary}\n`);
    }
    process.exit(1);
  } else {
    console.log('\n✅ All applications are on the latest patch version');
    if (process.env.GITHUB_OUTPUT) {
      const { appendFileSync } = await import('node:fs');
      appendFileSync(process.env.GITHUB_OUTPUT, `patches_found=false\n`);
      appendFileSync(process.env.GITHUB_OUTPUT, `patch_count=0\n`);
    }
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(2);
});
