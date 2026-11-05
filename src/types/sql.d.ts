// Bun imports SQL migration files as text when the import carries
// `with { type: 'text' }`. TypeScript needs the module shape to typecheck it.
declare module '*.sql' {
  const content: string
  export default content
}
