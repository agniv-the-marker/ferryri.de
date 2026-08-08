import { defineConfig } from 'vite';

export default defineConfig({
  // ferryri.de will live at the domain root; override for project-page previews.
  base: process.env.BASE_PATH ?? '/',
  build: { target: 'es2022' },
});
