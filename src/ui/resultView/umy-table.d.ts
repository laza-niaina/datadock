/**
 * Ambient declarations for the result webview bundle.
 *
 * `umy-table` (MIT, v1.0.8) ships a webpack CommonJS bundle without type
 * definitions; the Vue plugin shape is declared here. The grid components
 * (`ux-grid`, `ux-table-column`, ...) are installed globally by `Vue.use` and
 * used through render functions where string tags need no declaration; column
 * slots flow in via the render-function `scopedSlots` map.
 */
declare module 'umy-table' {
  import type { PluginObject } from 'vue';
  const UmyTable: PluginObject<unknown>;
  export default UmyTable;
}

/** CSS side effects are bundled by esbuild; no type surface needed. */
declare module '*.css';