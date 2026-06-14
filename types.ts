import type Docker from 'dockerode'

export interface AppConfig {
  dockerConf: Docker.DockerOptions
  confDir: string
  suffix: string
  template: string
  destination?: string
}

export interface DockerEvent {
  status?: string
}
