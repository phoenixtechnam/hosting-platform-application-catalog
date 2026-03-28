# Hosting Platform Application Catalog

Official application catalog for the [K8s Hosting Platform](https://github.com/phoenixtechnam/k8s-hosting-platform).

This catalog provides **managed application stacks** — self-contained, Helm-deployed applications with auto-configured databases, ingress, and storage. Each application installs with one click and manages its own lifecycle.

For **composable building blocks** (generic PHP/Node.js runtimes, databases, Redis) that clients assemble manually, see the [Workload Catalog](https://github.com/phoenixtechnam/hosting-platform-workload-catalog). See ADR-026 for the architectural rationale.

## Applications

| Name | Category | Components | Tenancy | Min Resources | Host Ports |
|------|----------|------------|---------|---------------|------------|
| WordPress | CMS | App + MariaDB + Redis + CronJob | Single | 0.25 CPU, 256Mi | None |
| Nextcloud | Productivity | App + MariaDB + Redis + Collabora + Cron | Single/Multi | 0.50 CPU, 512Mi | None |
| Jitsi Meet | Communication | Web + Prosody + JiCoFo + JVB + Coturn | Single | 1.00 CPU, 2Gi | UDP 10000, UDP 3478 |
| Moodle Bitnami | Education | App + MariaDB + Redis + Cron | Single | 0.50 CPU, 1Gi | None |
| Coturn | Communication | TURN/STUN server | Single | 0.10 CPU, 64Mi | UDP/TCP 3478 |

## How It Works

1. Admin registers this repo in the platform: **Settings > Application Repositories > Add**
2. Platform syncs `catalog.json` and each app's `manifest.json`
3. Admin or client clicks **Install** in the panel
4. Platform fills in parameters (domain, admin password, etc.)
5. Platform runs `helm install` with the app's chart and generated values
6. Application is live — database, ingress, TLS, and storage are all auto-configured

## Structure

```
catalog.json                       # Index of all applications
schema/
  app-manifest.schema.json         # JSON Schema for manifest validation
scripts/
  validate.mjs                     # CI validation script
<app-name>/
  manifest.json                    # App metadata, parameters, networking, resources
  chart/                           # Helm chart
    Chart.yaml                     # Helm chart metadata
    values.yaml                    # Default Helm values
    templates/                     # Kubernetes manifest templates
      deployment.yaml
      statefulset-*.yaml
      service.yaml
      ingress.yaml
      pvc.yaml
      secret.yaml
      cronjob.yaml                 # Optional
      _helpers.tpl                 # Template helpers
```

## Manifest Schema

Every `manifest.json` must conform to `schema/app-manifest.schema.json`.

### Core Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Human-readable display name |
| `code` | string | Yes | Unique identifier slug (must match directory name) |
| `version` | string | Yes | Application version (e.g., `6.x`, `28`, `stable`) |
| `description` | string | Yes | Short description for catalog UI |
| `category` | enum | Yes | `cms`, `productivity`, `communication`, `education`, `development`, `analytics`, `identity`, `ecommerce`, `media`, `other` |
| `min_plan` | enum | Yes | `starter`, `business`, or `premium` |
| `tenancy` | string[] | Yes | `["single-tenant"]` and/or `["multi-tenant"]` |
| `tags` | string[] | Yes | Keywords for search/filtering |

### Components

Each entry in `components[]` describes a Kubernetes resource the chart deploys:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Component name (e.g., `wordpress`, `mariadb`, `redis`) |
| `type` | enum | Yes | `deployment`, `statefulset`, `cronjob`, or `job` |
| `image` | string | Yes | Container image reference |
| `ports` | array | No | `[{ port, protocol, ingress }]` — which ports are exposed |
| `optional` | boolean | No | Whether this component can be disabled |
| `schedule` | string | No | Cron schedule (required for `cronjob` type) |

### Networking

| Field | Type | Description |
|-------|------|-------------|
| `networking.ingress_ports` | array | Ports exposed via NGINX Ingress with TLS |
| `networking.host_ports` | array | Ports requiring direct host-level exposure (UDP media, SSH) |
| `networking.websocket` | boolean | Whether the app needs WebSocket upgrade support |
| `networking.notes` | string | Operator notes about networking requirements |

**Host ports** include conflict-prevention fields:

| Field | Description |
|-------|-------------|
| `port` | Port number |
| `protocol` | TCP or UDP |
| `component` | Which component needs this port |
| `optional` | App works without it (degraded) |
| `remappable` | Platform can assign a different port |
| `remap_range` | `[min, max]` port range for remapping |
| `max_instances_per_node` | Limit for non-remappable ports |

### Volumes

Each entry in `volumes[]` describes a PVC:

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Volume name (used in PVC naming) |
| `mount_path` | string | Container mount path |
| `default_size` | string | Default PVC size (e.g., `5Gi`) |
| `description` | string | Human-readable purpose |
| `optional` | boolean | Whether this volume can be skipped |

### Resources

| Field | Description |
|-------|-------------|
| `resources.default` | Default CPU/memory/storage for new deployments |
| `resources.minimum` | Minimum viable resources (platform enforces this floor) |

### Parameters

Each entry in `parameters[]` drives the admin panel deployment form and maps to Helm values:

| Field | Type | Description |
|-------|------|-------------|
| `key` | string | Helm values path (e.g., `wordpress.adminUser`, `ingress.domain`) |
| `label` | string | Human-readable label for the UI form |
| `type` | enum | `string`, `secret`, `boolean`, `integer`, `string[]` |
| `default` | any | Default value (optional) |
| `required` | boolean | Whether the admin must fill this in |
| `description` | string | Help text shown in the UI |

### Health Check

| Field | Description |
|-------|-------------|
| `health_check.path` | HTTP GET path for the primary web component |
| `health_check.port` | Port to probe |
| `health_check.initial_delay_seconds` | Wait before first probe |
| `health_check.period_seconds` | Interval between probes |

## Workload Catalog vs Application Catalog (ADR-026)

| | Workload Catalog | Application Catalog |
|---|---|---|
| **What** | Generic runtimes, databases, services | Complete managed application stacks |
| **Examples** | `apache-php84`, `node22`, `mariadb-106` | WordPress, Nextcloud, Jitsi, Moodle |
| **User experience** | Client uploads files, installs software manually | One-click install, everything pre-configured |
| **Database** | Shared, platform-managed, multiple workloads can use it | Bundled in the Helm chart, isolated per app |
| **Deployment** | Platform generates K8s manifests | `helm install` |
| **Lifecycle** | Independent — add/remove workloads freely | Atomic — install/uninstall the whole stack |

## Validation

All manifests are validated on every push and PR. CI runs three checks:

1. **Manifest validation** — JSON Schema compliance for every `manifest.json`
2. **Helm lint** — `helm lint --strict` on every `chart/` directory
3. **JSON formatting** — consistent formatting check

```bash
# Run locally
npm install
npm run validate

# Helm lint (requires helm CLI)
helm lint wordpress/chart --strict
```

## Adding a New Application

1. Create a new directory: `my-app/`
2. Add `manifest.json` conforming to `schema/app-manifest.schema.json`
3. Add `chart/` with `Chart.yaml`, `values.yaml`, and `templates/`
4. Add the directory name to `catalog.json` → `applications` array
5. Run `npm run validate` and `helm lint my-app/chart --strict`
6. Commit and push — CI validates automatically

## Usage

Add this repository in the K8s Hosting Platform admin panel:

**Settings > Application Repositories > Add Repository**

- Name: `Official Application Catalog`
- URL: `https://github.com/phoenixtechnam/hosting-platform-application-catalog`
- Branch: `main`
