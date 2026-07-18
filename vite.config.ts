import { sveltekit } from '@sveltejs/kit/vite';
import { paraglide } from '@inlang/paraglide-sveltekit/vite';
import { defineConfig, type Plugin } from 'vite';
import fs from 'fs';
import path from 'path';

// @sveltejs/kit's client runtime statically imports Svelte 5's async APIs
// (untrack/fork/settled) and guards them at runtime, so on Svelte 4 they are
// dead code — but Rollup still warns that the named exports are missing.
// SvelteKit installs its own rollup `onwarn`, overriding one set in this
// config's `build.rollupOptions`, so a post-enforced plugin is needed: its
// `config` hook runs after sveltekit()'s and can wrap the handler kit
// injected, silencing only these exact false positives.
function silenceKitSvelte5MissingExports(): Plugin {
    return {
        name: 'silence-kit-svelte5-missing-exports',
        enforce: 'post',
        config(config) {
            const kitOnwarn = config.build?.rollupOptions?.onwarn;
            return {
                build: {
                    rollupOptions: {
                        onwarn(warning, defaultHandler) {
                            if (
                                warning.code === 'MISSING_EXPORT' &&
                                (warning.id ?? '').includes('/@sveltejs/kit/') &&
                                ['untrack', 'fork', 'settled'].includes(warning.binding ?? '')
                            ) {
                                return;
                            }
                            if (kitOnwarn) kitOnwarn(warning, defaultHandler);
                            else defaultHandler(warning);
                        },
                    },
                },
            };
        },
    };
}

export default defineConfig(({ mode }) => {
    const isProduction = mode === 'production';

    const appVersion = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf-8')).version;

    const port = 5173;
    const secureMode = process.env.SECURE_BUILD === 'true' || isProduction;

    // HTTPS for dev/preview, needed for camera/microphone access (secure context).
    // Falls back to plain HTTP when no local certs exist so fresh clones work out of
    // the box — see "Running Your Own Instance" in README.md for generating certs.
    const certKeyPath = path.resolve('.certs/localhost+2-key.pem');
    const certPath = path.resolve('.certs/localhost+2.pem');
    const httpsOptions =
        fs.existsSync(certKeyPath) && fs.existsSync(certPath)
            ? {
                  key: fs.readFileSync(certKeyPath),
                  cert: fs.readFileSync(certPath),
              }
            : undefined;

    const serverConfig = !isProduction
        ? {
              ...(httpsOptions ? { https: httpsOptions } : {}),
              host: '0.0.0.0',
              port,
              headers: {
                  'Permissions-Policy': 'camera=*, microphone=*, display-capture=*',
                  'Feature-Policy': 'camera *; microphone *; display-capture *',
              },
          }
        : {};

    return {
        plugins: [
            paraglide({ project: './project.inlang', outdir: './src/paraglide' }),
            sveltekit(),
            silenceKitSvelte5MissingExports(),
        ],
        css: {
            devSourcemap: true,
            preprocessorOptions: {
                scss: {
                    api: 'modern-compiler',
                },
            },
        },
        server: serverConfig,
        preview: {
            ...(httpsOptions ? { https: httpsOptions } : {}),
            host: '0.0.0.0',
            port,
        },
        define: {
            global: 'globalThis',
            __SECURE_BUILD__: secureMode,
            __DEV__: !secureMode,
            __APP_VERSION__: JSON.stringify(appVersion),
        },
        build: {
            minify: 'terser',
            terserOptions: isProduction
                ? {
                      compress: {
                          drop_console: true,
                          drop_debugger: true,
                          pure_funcs: [
                              'console.log',
                              'console.info',
                              'console.debug',
                              'console.warn',
                          ],
                      },
                  }
                : undefined,
        },
    };
});
