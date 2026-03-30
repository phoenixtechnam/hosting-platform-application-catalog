#!/usr/bin/env node

/**
 * Validates all application manifest.json files against the JSON Schema
 * and checks Helm chart structure and catalog.json completeness.
 *
 * Usage: node scripts/validate.mjs
 * Exit code 0 = all valid, 1 = errors found
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

let errors = 0;
let warnings = 0;

function error(msg) {
  console.error(`  ✗ ${msg}`);
  errors++;
}

function warn(msg) {
  console.warn(`  ⚠ ${msg}`);
  warnings++;
}

function ok(msg) {
  console.log(`  ✓ ${msg}`);
}

// ── Load schema ──────────────────────────────────────────────────────────────

const schemaPath = join(ROOT, 'schema', 'app-manifest.schema.json');
if (!existsSync(schemaPath)) {
  console.error('FATAL: schema/app-manifest.schema.json not found');
  process.exit(1);
}

const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

// ── Load catalog.json ────────────────────────────────────────────────────────

console.log('\n📋 Validating catalog.json...');

const catalogPath = join(ROOT, 'catalog.json');
if (!existsSync(catalogPath)) {
  error('catalog.json not found');
  process.exit(1);
}

const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));

if (!catalog.version) error('catalog.json missing "version" field');
if (!catalog.name) error('catalog.json missing "name" field');
if (!Array.isArray(catalog.applications)) {
  error('catalog.json missing "applications" array');
  process.exit(1);
}
if (catalog.applications.length === 0) {
  error('catalog.json "applications" array is empty');
}

const catalogSet = new Set(catalog.applications);
if (catalogSet.size !== catalog.applications.length) {
  error('catalog.json contains duplicate application entries');
}

ok(`catalog.json has ${catalog.applications.length} application(s)`);

// ── Discover application directories ─────────────────────────────────────────

const SKIP_DIRS = new Set(['.git', '.github', 'node_modules', 'schema', 'scripts']);

const dirs = readdirSync(ROOT).filter((name) => {
  const full = join(ROOT, name);
  return statSync(full).isDirectory() && !name.startsWith('.') && !SKIP_DIRS.has(name);
});

// ── Validate each manifest ───────────────────────────────────────────────────

console.log('\n📦 Validating application manifests...\n');

const manifestCodes = new Set();

for (const dir of dirs) {
  const manifestPath = join(ROOT, dir, 'manifest.json');
  console.log(`  ${dir}/manifest.json`);

  if (!existsSync(manifestPath)) {
    error(`${dir}/manifest.json not found`);
    continue;
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    error(`${dir}/manifest.json is not valid JSON: ${e.message}`);
    continue;
  }

  // Schema validation
  const valid = validate(manifest);
  if (!valid) {
    for (const err of validate.errors) {
      const path = err.instancePath || '(root)';
      error(`${dir}: ${path} ${err.message}`);
    }
    continue;
  }

  // Code must match directory name
  if (manifest.code !== dir) {
    error(`${dir}: code "${manifest.code}" does not match directory name "${dir}"`);
  }

  // Duplicate code check
  if (manifestCodes.has(manifest.code)) {
    error(`${dir}: duplicate code "${manifest.code}"`);
  }
  manifestCodes.add(manifest.code);

  // Must have at least one component with ingress: true
  const hasIngress = manifest.components.some(
    (c) => c.ports && c.ports.some((p) => p.ingress)
  );
  if (!hasIngress) {
    warn(`${dir}: no component has a port with ingress: true`);
  }

  // Validate host_ports reference valid components
  if (manifest.networking.host_ports) {
    const componentNames = new Set(manifest.components.map((c) => c.name));
    for (const hp of manifest.networking.host_ports) {
      if (!componentNames.has(hp.component)) {
        error(`${dir}: host_port references unknown component "${hp.component}"`);
      }
    }
  }

  // Parameter keys should be unique
  const paramKeys = manifest.parameters.map((p) => p.key);
  const uniqueKeys = new Set(paramKeys);
  if (uniqueKeys.size !== paramKeys.length) {
    error(`${dir}: duplicate parameter keys found`);
  }

  // Reject floating / unpinned image tags
  const FLOATING_TAGS = new Set([
    'latest', 'release', 'stable', 'edge', 'nightly',
    'dev', 'canary', 'beta', 'alpha', 'rc',
  ]);

  for (const comp of manifest.components) {
    const image = comp.image;
    const colonIdx = image.lastIndexOf(':');
    if (colonIdx === -1 || colonIdx === image.length - 1) {
      error(`${dir}: component "${comp.name}" image "${image}" has no tag — implicit :latest is not allowed. Pin to a specific version.`);
      continue;
    }
    const tag = image.slice(colonIdx + 1);
    if (FLOATING_TAGS.has(tag.toLowerCase())) {
      error(`${dir}: component "${comp.name}" image "${image}" uses floating tag ":${tag}". Pin to a specific version.`);
    }
  }

  // Also check cronjobs if present
  if (manifest.cronjobs) {
    for (const cj of manifest.cronjobs) {
      if (cj.image) {
        const colonIdx = cj.image.lastIndexOf(':');
        if (colonIdx === -1 || colonIdx === cj.image.length - 1) {
          error(`${dir}: cronjob "${cj.name}" image "${cj.image}" has no tag — implicit :latest is not allowed.`);
          continue;
        }
        const tag = cj.image.slice(colonIdx + 1);
        if (FLOATING_TAGS.has(tag.toLowerCase())) {
          error(`${dir}: cronjob "${cj.name}" image "${cj.image}" uses floating tag ":${tag}". Pin to a specific version.`);
        }
      }
    }
  }

  // Validate supportedVersions if present
  if (manifest.supportedVersions) {
    const componentNames = new Set(manifest.components.map((c) => c.name));
    const versionIds = new Set();

    for (const sv of manifest.supportedVersions) {
      if (versionIds.has(sv.version)) {
        error(`${dir}: duplicate supportedVersion "${sv.version}"`);
      }
      versionIds.add(sv.version);

      // Check version-specific component images for floating tags
      for (const comp of sv.components) {
        if (!componentNames.has(comp.name)) {
          error(`${dir}: supportedVersion "${sv.version}" references unknown component "${comp.name}"`);
        }
        const colonIdx = comp.image.lastIndexOf(':');
        if (colonIdx === -1 || colonIdx === comp.image.length - 1) {
          error(`${dir}: supportedVersion "${sv.version}" component "${comp.name}" image "${comp.image}" has no tag`);
          continue;
        }
        const tag = comp.image.slice(colonIdx + 1);
        if (FLOATING_TAGS.has(tag.toLowerCase())) {
          error(`${dir}: supportedVersion "${sv.version}" component "${comp.name}" image "${comp.image}" uses floating tag ":${tag}"`);
        }
      }

      // Validate upgradeFrom references valid versions
      if (sv.upgradeFrom) {
        for (const from of sv.upgradeFrom) {
          if (!versionIds.has(from) && !manifest.supportedVersions.some((v) => v.version === from)) {
            warn(`${dir}: supportedVersion "${sv.version}" upgradeFrom references "${from}" which is not in supportedVersions`);
          }
        }
      }
    }
  }

  ok(`${dir}: valid (${manifest.category}, ${manifest.components.length} components)`);
}

// ── Check Helm chart structure ───────────────────────────────────────────────

console.log('\n⎈ Checking Helm chart structure...\n');

for (const dir of dirs) {
  const chartDir = join(ROOT, dir, 'chart');
  console.log(`  ${dir}/chart/`);

  if (!existsSync(chartDir)) {
    error(`${dir}: chart/ directory not found`);
    continue;
  }

  // Required files
  const requiredFiles = ['Chart.yaml', 'values.yaml'];
  for (const file of requiredFiles) {
    if (!existsSync(join(chartDir, file))) {
      error(`${dir}: chart/${file} not found`);
    }
  }

  // Templates directory
  const templatesDir = join(chartDir, 'templates');
  if (!existsSync(templatesDir)) {
    error(`${dir}: chart/templates/ directory not found`);
  } else {
    const templates = readdirSync(templatesDir);
    if (templates.length === 0) {
      error(`${dir}: chart/templates/ is empty`);
    } else {
      ok(`${dir}: chart/ valid (${templates.length} template files)`);
    }
  }

  // Validate Chart.yaml is valid YAML with required fields
  const chartYamlPath = join(chartDir, 'Chart.yaml');
  if (existsSync(chartYamlPath)) {
    const content = readFileSync(chartYamlPath, 'utf8');
    if (!content.includes('apiVersion:')) {
      error(`${dir}: Chart.yaml missing apiVersion`);
    }
    if (!content.includes('name:')) {
      error(`${dir}: Chart.yaml missing name`);
    }
    if (!content.includes('version:')) {
      error(`${dir}: Chart.yaml missing version`);
    }
  }
}

// ── Cross-reference catalog.json ↔ directories ──────────────────────────────

console.log('\n🔗 Cross-referencing catalog.json ↔ directories...');

for (const app of catalog.applications) {
  if (!dirs.includes(app)) {
    error(`catalog.json lists "${app}" but no directory found`);
  }
}

for (const dir of dirs) {
  if (!catalog.applications.includes(dir)) {
    warn(`directory "${dir}" exists but is not listed in catalog.json`);
  }
}

// ── Summary ──────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(50));
if (errors > 0) {
  console.error(`\n❌ ${errors} error(s), ${warnings} warning(s)\n`);
  process.exit(1);
} else {
  console.log(`\n✅ All ${dirs.length} application(s) valid, ${warnings} warning(s)\n`);
  process.exit(0);
}
