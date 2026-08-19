variable "project_id" {
  type = string
}

variable "region" {
  type    = string
  default = "europe-west2"
}

variable "container_image" {
  type = string
}

variable "service_name" {
  type    = string
  default = "rxflow-api"
}

variable "database_instance_name" {
  type    = string
  default = "rxflow-postgres"
}

variable "database_name" {
  type    = string
  default = "rxflow"
}

variable "database_user" {
  type    = string
  default = "rxflow_app"
}

variable "database_tier" {
  type    = string
  default = "db-custom-1-3840"
}

variable "database_deletion_protection" {
  type    = bool
  default = false
}

variable "cloud_run_min_instances" {
  type    = number
  default = 0
}

variable "cloud_run_max_instances" {
  type    = number
  default = 10
}

variable "postgres_pool_max" {
  type    = number
  default = 5
}


variable "worker_min_instances" {
  type    = number
  default = 1
}

variable "worker_max_instances" {
  type    = number
  default = 4
}

variable "worker_postgres_pool_max" {
  type    = number
  default = 5
}

variable "worker_publish_interval_ms" {
  type    = number
  default = 250
}

variable "worker_per_tenant_claim_limit" {
  type    = number
  default = 20
}

variable "outbox_pending_age_target_ms" {
  type    = number
  default = 60000
}

variable "worker_tenant_delivery_concurrency" {
  type    = number
  default = 4
}
