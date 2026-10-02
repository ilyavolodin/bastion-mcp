{{/* Names */}}
{{- define "bastion.name" -}}bastion{{- end -}}

{{- define "bastion.fullname" -}}
{{- if contains "bastion" .Release.Name -}}
{{- .Release.Name | trunc 50 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-bastion" .Release.Name | trunc 50 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "bastion.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "bastion.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "bastion.chartLabel" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Pods that run the worker role carry component=worker in split mode and component=all in all-in-one mode. */}}
{{- define "bastion.workerComponent" -}}
{{- if eq .Values.deploymentMode "all" -}}all{{- else -}}worker{{- end -}}
{{- end -}}

{{- define "bastion.selectorLabels" -}}
app.kubernetes.io/name: {{ include "bastion.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "bastion.labels" -}}
helm.sh/chart: {{ include "bastion.chartLabel" .root }}
{{ include "bastion.selectorLabels" . }}
app.kubernetes.io/version: {{ .root.Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
{{- end -}}

{{/* Images */}}
{{- define "bastion.image" -}}
{{- if .Values.image.digest -}}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest -}}
{{- else -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) -}}
{{- end -}}
{{- end -}}

{{- define "bastion.sandboxImage" -}}
{{- if .Values.sandbox.image.digest -}}
{{- printf "%s@%s" .Values.sandbox.image.repository .Values.sandbox.image.digest -}}
{{- else -}}
{{- printf "%s:%s" .Values.sandbox.image.repository (default .Chart.AppVersion .Values.sandbox.image.tag) -}}
{{- end -}}
{{- end -}}

{{/* Host of publicUrl, without scheme and port. */}}
{{- define "bastion.host" -}}
{{- $url := required "publicUrl is required (for example https://mcp.example.com)" .Values.publicUrl -}}
{{- (urlParse $url).hostname -}}
{{- end -}}

{{/* Roles shown to the process. */}}
{{- define "bastion.role" -}}
{{- if eq . "all" -}}all{{- else -}}{{ . }}{{- end -}}
{{- end -}}

{{/*
Environment shared by every Bastion container. Call with (dict "root" $ "role" "worker|ui|all").
Secret-backed values come from existingSecret; BASTION_* names follow tdd 19.1.
*/}}
{{- define "bastion.env" -}}
{{- $v := .root.Values -}}
{{- $secret := required "existingSecret is required (keys DATABASE_URL, REDIS_URL, INTERNAL_SECRET)" $v.existingSecret -}}
- name: BASTION_ROLE
  value: {{ .role | quote }}
- name: BASTION_PUBLIC_URL
  value: {{ required "publicUrl is required (for example https://mcp.example.com)" $v.publicUrl | quote }}
- name: BASTION_HTTP_PORT
  value: {{ $v.worker.ports.http | quote }}
- name: BASTION_INTERNAL_PORT
  value: {{ $v.worker.ports.internal | quote }}
- name: BASTION_EGRESS_PORT
  value: {{ $v.worker.ports.egress | quote }}
- name: BASTION_DATABASE_URL
  valueFrom:
    secretKeyRef: { name: {{ $secret }}, key: DATABASE_URL }
- name: BASTION_REDIS_URL
  valueFrom:
    secretKeyRef: { name: {{ $secret }}, key: REDIS_URL }
- name: BASTION_INTERNAL_SECRET
  valueFrom:
    secretKeyRef: { name: {{ $secret }}, key: INTERNAL_SECRET }
- name: BASTION_INTERNAL_SECRET_PREVIOUS
  valueFrom:
    secretKeyRef: { name: {{ $secret }}, key: INTERNAL_SECRET_PREVIOUS, optional: true }
- name: BASTION_DATABASE_REPLICA_URL
  valueFrom:
    secretKeyRef: { name: {{ $secret }}, key: DATABASE_REPLICA_URL, optional: true }
- name: BASTION_KMS
  value: {{ $v.kms.provider | quote }}
{{- if $v.kms.key }}
- name: BASTION_KMS_KEY
  value: {{ $v.kms.key | quote }}
{{- end }}
{{- range $v.kms.credentialKeys }}
- name: {{ . }}
  valueFrom:
    secretKeyRef: { name: {{ $secret }}, key: {{ . }}, optional: true }
{{- end }}
- name: BASTION_SANDBOX_DRIVER
  value: {{ default (ternary "kubernetes" "bubblewrap" $v.sandbox.enabled) $v.sandbox.driver | quote }}
- name: BASTION_SANDBOX_NAMESPACE
  value: {{ $v.sandbox.namespace | quote }}
- name: BASTION_SANDBOX_RUNTIME_CLASS
  value: {{ $v.sandbox.runtimeClassName | quote }}
- name: BASTION_SANDBOX_IMAGE
  value: {{ include "bastion.sandboxImage" .root | quote }}
{{- if $v.bootstrapAdminEmail }}
- name: BASTION_BOOTSTRAP_ADMIN_EMAIL
  value: {{ $v.bootstrapAdminEmail | quote }}
{{- end }}
- name: BASTION_LOCAL_LOGIN
  value: {{ $v.localLogin | quote }}
- name: BASTION_LOG_LEVEL
  value: {{ $v.logLevel | quote }}
{{- if $v.clusterCIDRs }}
- name: BASTION_CLUSTER_CIDRS
  value: {{ join "," $v.clusterCIDRs | quote }}
{{- end }}
- name: BASTION_EXPECTED_WORKERS
  value: {{ include "bastion.expectedWorkers" .root | quote }}
{{- if or (eq .role "ui") (eq .role "all") }}
- name: BASTION_GIT_CACHE_DIR
  value: {{ (ternary $v.all.gitCache.mountPath $v.ui.gitCache.mountPath (eq .role "all")) | quote }}
{{- end }}
{{- if $v.otelCollector.enabled }}
- name: OTEL_EXPORTER_OTLP_ENDPOINT
  value: "http://{{ include "bastion.fullname" .root }}-otel-collector:4318"
- name: OTEL_EXPORTER_OTLP_PROTOCOL
  value: http/protobuf
{{- end }}
{{- range $k, $val := $v.env }}
- name: {{ $k }}
  value: {{ $val | quote }}
{{- end }}
{{- with $v.extraEnv }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{/* BASTION_EXPECTED_WORKERS (19.1): used for local limits when Redis is down. */}}
{{- define "bastion.expectedWorkers" -}}
{{- if eq .Values.deploymentMode "all" -}}
{{- .Values.all.replicas -}}
{{- else if .Values.worker.autoscaling.enabled -}}
{{- .Values.worker.autoscaling.minReplicas -}}
{{- else -}}
{{- .Values.worker.replicas -}}
{{- end -}}
{{- end -}}

{{/* Topology spread constraints with the role's labelSelector. Call with (dict "root" $ "component" "worker"). */}}
{{- define "bastion.topologySpread" -}}
{{- range .root.Values.topologySpreadConstraints }}
- {{ toYaml (omit . "labelSelector") | nindent 2 | trim }}
  labelSelector:
    matchLabels:
      {{- include "bastion.selectorLabels" (dict "root" $.root "component" $.component) | nindent 6 }}
{{- end }}
{{- end -}}

{{/* Volumes and mounts for KMS key and scratch space. Call with (dict "root" $ "role" ...). */}}
{{- define "bastion.volumeMounts" -}}
- name: tmp
  mountPath: /tmp
- name: data
  mountPath: /var/lib/bastion
{{- if and (eq .root.Values.kms.provider "local") .root.Values.kms.localKeySecret }}
- name: kms-local-key
  mountPath: /keys
  readOnly: true
{{- end }}
{{- if or (eq .role "ui") (eq .role "all") }}
- name: git-cache
  mountPath: {{ (ternary .root.Values.all.gitCache.mountPath .root.Values.ui.gitCache.mountPath (eq .role "all")) }}
{{- end }}
{{- end -}}

{{- define "bastion.volumes" -}}
- name: tmp
  emptyDir: {}
- name: data
  emptyDir: {}
{{- if and (eq .root.Values.kms.provider "local") .root.Values.kms.localKeySecret }}
- name: kms-local-key
  secret:
    secretName: {{ .root.Values.kms.localKeySecret }}
    defaultMode: 0400
    items:
      - key: {{ .root.Values.kms.localKeySecretKey }}
        path: kek
{{- end }}
{{- if or (eq .role "ui") (eq .role "all") }}
- name: git-cache
  emptyDir:
    sizeLimit: {{ (ternary .root.Values.all.gitCache.sizeLimit .root.Values.ui.gitCache.sizeLimit (eq .role "all")) }}
{{- end }}
{{- end -}}
