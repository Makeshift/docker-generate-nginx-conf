declare module 'es6-template-strings' {
  export type TemplateValue = string | number | boolean | null | undefined | TemplateContext | TemplateFunction

  export interface TemplateContext {
    [name: string]: TemplateValue
  }

  export type TemplateFunction = (...args: TemplateValue[]) => TemplateValue

  export interface CompiledTemplate {
    literals: string[]
    substitutions: string[]
  }

  export interface ResolveOptions {
    partial?: boolean
  }

  function template<Context extends object> (template: string, context: Context, options?: ResolveOptions): string

  export = template
}

declare module 'es6-template-strings/compile' {
  import type { CompiledTemplate } from 'es6-template-strings'

  function compile (template: string): CompiledTemplate

  export = compile
}

declare module 'es6-template-strings/resolve-to-string' {
  import type { CompiledTemplate, ResolveOptions } from 'es6-template-strings'

  function resolveToString<Context extends object> (template: CompiledTemplate, context: Context, options?: ResolveOptions): string

  export = resolveToString
}

declare module 'es6-template-strings/resolve-to-array' {
  import type { CompiledTemplate, ResolveOptions, TemplateValue } from 'es6-template-strings'

  function resolveToArray<Context extends object> (template: CompiledTemplate, context: Context, options?: ResolveOptions): [string[], ...TemplateValue[]]

  export = resolveToArray
}
