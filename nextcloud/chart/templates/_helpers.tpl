{{/*
Generate the fullname for resources.
*/}}
{{- define "nextcloud.fullname" -}}
{{- if .Release.Name -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{/*
Common labels applied to all resources.
*/}}
{{- define "nextcloud.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{ include "nextcloud.selectorLabels" . }}
{{- end -}}

{{/*
Selector labels used in matchLabels and label selectors.
*/}}
{{- define "nextcloud.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Escape dots in domain for Collabora environment variable.
*/}}
{{- define "nextcloud.escapedDomain" -}}
{{- .Values.ingress.domain | replace "." "\\." -}}
{{- end -}}
