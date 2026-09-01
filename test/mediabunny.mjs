// Page-side test code reaches mediabunny through this module rather than a bare
// specifier: code inside page.evaluate() is never transformed by Vite, so
// `import('mediabunny')` has nothing to resolve it. A real module path does.
export * from 'mediabunny';
