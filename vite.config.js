import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Relative base so the built site works whether it's served from the domain
  // root or a subpath like gaiaforge.tech/battery/.
  base: './',
  plugins: [react()],
});
