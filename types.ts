import type Docker from 'dockerode'

export interface AppConfig {
  docker_conf: Docker.DockerOptions
  conf_dir: string
  suffix: string
  template: string
  destination?: string
}

export interface DockerEvent {
  status?: string
}

export type ProxyContainer = Docker.ContainerInfo

export interface TemplateParams {
  server_names: string
  proxy_pass: string
  is_public: string
  single_server_name: string
  remote_ip?: string
}
