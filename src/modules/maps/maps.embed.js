import { randomBytes } from 'node:crypto';

import { env } from '../../config/env.js';
import { getSetting } from '../platform/platform.service.js';

/**
 * Google Maps page the apps show inside an iframe (web) or WebView (Android).
 * The pins come in the URL hash as JSON, so the page never asks the API for user data:
 *   /api/v1/maps/embed#{"pins":[{"lat":28.61,"lng":77.2,"label":"You","me":true}],"mode":"full"}
 * mode: full (drag / pinch freely), embed (ctrl + scroll to zoom), static (no gestures, preview).
 * The apps can also call window.scSetData({...}) to move the pins without reloading the page.
 */
export async function mapsKey() {
  const sys = await getSetting('system');
  if (sys.mapsEnabled === false) return '';
  return sys.mapsApiKey || env.GOOGLE_MAPS_API_KEY;
}

const page = (key, nonce) => `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>Map</title>
<style nonce="${nonce}">
html, body, #map { margin: 0; padding: 0; width: 100%; height: 100%; background: #e9eef2; font-family: Inter, Roboto, Arial, sans-serif; }
#msg { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; text-align: center; padding: 16px; color: #5f6b7a; font-size: 13px; }
.sc-label { background: #fff; color: #1f2933 !important; padding: 2px 7px; border-radius: 6px; box-shadow: 0 1px 4px rgba(0, 0, 0, .25); white-space: nowrap; transform: translateY(-4px); }
</style>
</head>
<body>
<div id="map"></div>
<div id="msg">${key ? 'Loading map...' : 'Map is not set up'}</div>
<script nonce="${nonce}">
(function () {
  var PIN = 'M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z';
  var map = null, markers = [], state = read();
  var msg = document.getElementById('msg');

  function read() {
    try { return JSON.parse(decodeURIComponent(location.hash.replace(/^#/, ''))) || {}; } catch (e) { return {}; }
  }
  function options() {
    var mode = state.mode || 'embed';
    return {
      gestureHandling: mode === 'static' ? 'none' : mode === 'full' ? 'greedy' : 'cooperative',
      disableDefaultUI: mode === 'static',
      zoomControl: mode !== 'static',
      keyboardShortcuts: mode !== 'static',
      clickableIcons: false,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: false,
    };
  }
  function render() {
    if (!map) return;
    map.setOptions(options());
    markers.forEach(function (m) { m.setMap(null); });
    markers = [];
    var pins = (state.pins || []).filter(function (p) { return isFinite(p.lat) && isFinite(p.lng); });
    var bounds = new google.maps.LatLngBounds();
    pins.forEach(function (p) {
      var pos = { lat: +p.lat, lng: +p.lng };
      bounds.extend(pos);
      markers.push(new google.maps.Marker({
        map: map,
        position: pos,
        title: p.label || '',
        zIndex: p.me ? 10 : 1,
        label: p.label ? { text: String(p.label).slice(0, 24), className: 'sc-label', fontSize: '11px', fontWeight: '600' } : null,
        icon: {
          path: PIN,
          fillColor: p.me ? (state.meColor || '#2563eb') : (state.color || '#16a34a'),
          fillOpacity: 1,
          strokeColor: '#ffffff',
          strokeWeight: 1.5,
          scale: 1.6,
          anchor: new google.maps.Point(12, 22),
          labelOrigin: new google.maps.Point(12, -3),
        },
      }));
    });
    if (pins.length === 1) {
      map.setCenter({ lat: +pins[0].lat, lng: +pins[0].lng });
      map.setZoom(state.zoom || 15);
    } else if (pins.length > 1) {
      map.fitBounds(bounds, 56);
      google.maps.event.addListenerOnce(map, 'idle', function () { if (map.getZoom() > 17) map.setZoom(17); });
    }
  }

  window.scSetData = function (d) { state = d || {}; render(); };
  // The app view can start small and grow (Android WebView): fit the pins again on every resize.
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { if (map) { google.maps.event.trigger(map, 'resize'); render(); } }, 120);
  });
  window.addEventListener('hashchange', function () { state = read(); render(); });
  window.gm_authFailure = function () {
    msg.style.display = 'flex';
    msg.textContent = 'Map could not load: the Google Maps API key is not valid for this site.';
  };
  window.scInit = function () {
    msg.style.display = 'none';
    var o = options();
    o.center = { lat: 22.5, lng: 79 };
    o.zoom = 4;
    map = new google.maps.Map(document.getElementById('map'), o);
    render();
  };
})();
</script>
${key ? `<script nonce="${nonce}" async src="https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&callback=scInit&loading=async&v=weekly"></script>` : ''}
</body>
</html>`;

export async function mapEmbed(_req, res) {
  const key = await mapsKey();
  const nonce = randomBytes(16).toString('base64');
  // Google Maps needs its own scripts / tiles; the page may be framed by the web apps.
  res.removeHeader('X-Frame-Options');
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'",
      `script-src 'nonce-${nonce}' 'strict-dynamic' https://maps.googleapis.com https://maps.gstatic.com`,
      `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`,
      'img-src data: blob: https://*.googleapis.com https://*.gstatic.com https://*.google.com https://*.ggpht.com',
      'connect-src https://*.googleapis.com https://*.google.com https://*.gstatic.com data: blob:',
      'font-src https://fonts.gstatic.com',
      'worker-src blob:',
      'frame-ancestors *',
    ].join('; '),
    // The key can be restricted to this site (HTTP referrer); helmet's default sends no referrer.
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Cache-Control': 'no-cache',
  });
  res.type('html').send(page(key, nonce));
}
