// Node 20.6+ registration bridge for the Kimi ACP loader. `--import` is the
// supported replacement for `--loader` and avoids emitting an ExperimentalWarning
// into the user's Ruyi chat transcript on every Kimi turn.
import { register } from 'node:module';

register(new URL('./kimi-acp-compat-loader.mjs', import.meta.url));
