import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let compiler = null;

// The TypeScript compiler takes about two seconds to load. Every command pulls
// the parser modules in through the shared startup chain, but only a command
// that actually parses JS/TS source needs the compiler, so it is loaded on the
// first property access instead of at import time.
export default new Proxy({}, {
  get(_target, property) {
    compiler ??= require('typescript');
    return compiler[property];
  },
});
