/**
 * WebSocket-in-background-page helper for Firefox (MV2 has no Service Worker,
 * and background pages here are classic scripts, so we just expose WebSocket).
 * Kept as a separate file for parity with the MV3 build.
 */
// WebSocket is globally available in Firefox background pages; nothing to polyfill.
