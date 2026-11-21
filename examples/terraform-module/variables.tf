variable "name" {
  description = "Bucket name"
  type        = string
}

variable "tags" {
  description = "Tags for every resource"
  type        = map(string)
  default     = {}
}
