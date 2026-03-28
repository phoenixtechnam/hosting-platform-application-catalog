{{/*
Generate the fullname for resources.
*/}}
{{- define "jitsi.fullname" -}}
{{- if .Release.Name -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{/*
Common labels applied to all resources.
*/}}
{{- define "jitsi.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{ include "jitsi.selectorLabels" . }}
{{- end -}}

{{/*
Selector labels used in matchLabels and label selectors.
*/}}
{{- define "jitsi.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Component fullname helpers.
*/}}
{{- define "jitsi.web.fullname" -}}
{{- printf "%s-web" (include "jitsi.fullname" .) -}}
{{- end -}}

{{- define "jitsi.prosody.fullname" -}}
{{- printf "%s-prosody" (include "jitsi.fullname" .) -}}
{{- end -}}

{{- define "jitsi.jicofo.fullname" -}}
{{- printf "%s-jicofo" (include "jitsi.fullname" .) -}}
{{- end -}}

{{- define "jitsi.jvb.fullname" -}}
{{- printf "%s-jvb" (include "jitsi.fullname" .) -}}
{{- end -}}

{{- define "jitsi.coturn.fullname" -}}
{{- printf "%s-coturn" (include "jitsi.fullname" .) -}}
{{- end -}}
