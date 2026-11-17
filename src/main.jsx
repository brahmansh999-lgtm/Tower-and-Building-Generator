// ?widget=1 loads only the still renderer (no React, no UI, no styles);
// everything else boots the app exactly as before.
const query = new URLSearchParams(window.location.search);
if (query.get('widget') === '1') {
  import('./widget/widget.js')
    .then((m) => m.startWidget(query))
    .catch(() => {
      // Even if the module fails to load, end READY with a dark image.
      const c = document.createElement('canvas');
      const size = Math.min(2048, Math.max(64, Number.parseInt(query.get('size'), 10) || 1024));
      c.width = c.height = size;
      const g = c.getContext('2d');
      g.fillStyle = '#080a0e';
      g.fillRect(0, 0, size, size);
      document.body.style.margin = '0';
      document.body.innerHTML = '';
      document.body.appendChild(c);
      const image = c.toDataURL(query.get('format') === 'png' ? 'image/png' : 'image/jpeg', 0.9);
      window.getWidgetSnapshot = () => ({ image, meta: { seed: Number.parseInt(query.get('seed'), 10) || 1, typeName: '', towers: 0, heightM: 0, floors: 0, twistDeg: 0 } });
      window.__WIDGET_READY__ = true;
    });
} else {
  import('./boot.jsx');
}
