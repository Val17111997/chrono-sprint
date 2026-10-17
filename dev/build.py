import base64, json, pathlib, re
root = pathlib.Path(__file__).parent
dist = root.parent
fonts = ''
for w in (600, 700):
    b = (root / f'vendor/barlow-condensed-latin-{w}-normal.woff2').read_bytes()
    fonts += "@font-face{font-family:'Barlow Condensed';font-style:normal;font-weight:%d;font-display:swap;src:url(data:font/woff2;base64,%s) format('woff2');}\n" % (w, base64.b64encode(b).decode())
html = (root / 'src/index.template.html').read_text()
core = (root / 'src/core.js').read_text()
app = (root / 'src/app.js').read_text()
for name, code in (('core', core), ('app', app)):
    assert '</script' not in code
html = html.replace('/*__FONTS__*/', fonts).replace('/*__CORE__*/', core).replace('/*__APP__*/', app)
(dist / 'index.html').write_text(html)
version = re.search(r"VERSION = '([^']+)'", app).group(1)
sw = """const CACHE = 'chrono-sprint-%s';
const FILES = ['./', './index.html', './manifest.webmanifest', './icon.svg', './icon-180.png', './icon-192.png', './icon-512.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request).then((res) => {
    if (res.ok && new URL(e.request.url).origin === location.origin) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match('./index.html'))));
});
""" % version
(dist / 'sw.js').write_text(sw)
manifest = {"name": "Chrono Sprint", "short_name": "Chrono", "start_url": "./", "scope": "./", "display": "standalone", "orientation": "portrait",
            "background_color": "#F2F3F1", "theme_color": "#C2361F", "lang": "fr",
            "icons": [{"src": "icon-192.png", "sizes": "192x192", "type": "image/png"}, {"src": "icon-512.png", "sizes": "512x512", "type": "image/png"}, {"src": "icon.svg", "sizes": "any", "type": "image/svg+xml"}]}
(dist / 'manifest.webmanifest').write_text(json.dumps(manifest, ensure_ascii=False, indent=1))
svg = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#C2361F"/><rect x="132" y="96" width="26" height="320" rx="6" fill="#fff"/><rect x="354" y="96" width="26" height="320" rx="6" fill="#fff"/><rect x="132" y="243" width="248" height="26" rx="13" fill="#fff" opacity=".55"/><circle cx="256" cy="256" r="34" fill="#fff"/></svg>'''
(dist / 'icon.svg').write_text(svg)
from PIL import Image, ImageDraw
for size in (180, 192, 512):
    s = size / 512
    im = Image.new('RGBA', (size, size), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(112 * s), fill=(194, 54, 31, 255))
    for x in (132, 354): d.rounded_rectangle([x * s, 96 * s, (x + 26) * s, 416 * s], radius=6 * s, fill='white')
    d.rounded_rectangle([132 * s, 243 * s, 380 * s, 269 * s], radius=13 * s, fill=(255, 255, 255, 140))
    d.ellipse([(256 - 34) * s, (256 - 34) * s, (256 + 34) * s, (256 + 34) * s], fill='white')
    if size == 180:
        bg = Image.new('RGBA', (size, size), (194, 54, 31, 255)); bg.alpha_composite(im); im = bg
    im.save(dist / f'icon-{size}.png')
(dist / 'vercel.json').write_text(json.dumps({"headers": [
    {"source": "/(.*)", "headers": [{"key": "Cross-Origin-Opener-Policy", "value": "same-origin"}, {"key": "Cross-Origin-Embedder-Policy", "value": "require-corp"}, {"key": "Permissions-Policy", "value": "camera=(self), microphone=(self)"}]},
    {"source": "/sw.js", "headers": [{"key": "Cache-Control", "value": "no-cache"}]}]}, indent=1))
(dist / 'README.md').write_text('# Chrono Sprint\n\nChronométrage de sprint sans réseau avec deux téléphones (synchro acoustique côte à côte, détection caméra du passage).\n\nApp statique : `index.html` + service worker. Ouvrir en HTTPS, puis « Ajouter à l\'écran d\'accueil ».\n')
print('built', (dist / 'index.html').stat().st_size, 'bytes, version', version)
