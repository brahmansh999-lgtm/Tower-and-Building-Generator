import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

// HTTPS (self-signed) because WebXR only runs in a secure context, and
// host: true so a headset on the same Wi-Fi can open https://<local-ip>:5173.
export default defineConfig({
  plugins: [react(), basicSsl()],
  server: { host: true },
  preview: { host: true },
});
