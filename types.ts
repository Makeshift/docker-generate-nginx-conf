import type { Container } from 'node-docker-api/lib/container'

export interface AppConfig {
  docker_conf: DockerConnectionOptions
  conf_dir: string
  suffix: string
  template: string
  destination?: string
}

export interface DockerConnectionOptions {
  socketPath?: string
  host?: string
  port?: number
}

export interface DockerEvent {
  status?: string
}

export interface DockerPort {
  PrivatePort: number
  PublicPort?: number
}

export interface DockerContainerData {
  Labels: Record<string, string>
  Names: string[]
  NetworkSettings: {
    Networks: Record<string, object>
  }
  Ports: DockerPort[]
}

export type ProxyContainer = Container & {
  data: DockerContainerData
}

export interface TemplateParams {
  server_names: string
  proxy_pass: string
  is_public: string
  single_server_name: string
  remote_ip?: string
}
