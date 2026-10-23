// The line editor: draws a draft on the map and lets the user shape it.
//
// Tools:  draw     tap the map to extend the active branch
//         station  tap to place a station (snaps onto the line, or onto another
//                  line's station to make a transfer, taking over its name)
//         move     only drag things around
// Vertices and the "+" handles between them are draggable; tapping a vertex or a
// station opens a small menu. Every change is undoable.

import { nearestOnSegs, round5 } from './geo.js';

const SNAP_PX = 18;
const MAX_VERTEX_MARKERS = 400;

export class Editor {
  constructor(map, { t, otherStations, onChange }) {
    this.map = map;
    this.t = t;
    this.otherStations = otherStations;
    this.onChange = onChange;
    this.layer = L.layerGroup();
    this.vtxLayer = L.layerGroup();
    this.undoStack = [];
    this.tool = 'draw';
    this.active = 0;
    this.onClick = (e) => this.mapClick(e);
    this.onMove = () => this.renderVertices();
    this.onKey = (e) => this.key(e);
  }

  start(draft) {
    this.draft = draft;
    if (!draft.segs.length) draft.segs.push([]);
    this.active = draft.segs.length - 1;
    this.undoStack = [];
    this.layer.addTo(this.map);
    this.vtxLayer.addTo(this.map);
    this.map.on('click', this.onClick);
    this.map.on('moveend', this.onMove);
    document.addEventListener('keydown', this.onKey);
    this.map.getContainer().classList.add('hm-editing');
    this.map.doubleClickZoom.disable();
    this.setTool(draft.segs[0].length ? 'move' : 'draw');
    this.render();
  }

  stop() {
    this.map.off('click', this.onClick);
    this.map.off('moveend', this.onMove);
    document.removeEventListener('keydown', this.onKey);
    this.map.getContainer().classList.remove('hm-editing', 'hm-tool-draw', 'hm-tool-station', 'hm-tool-move');
    this.map.doubleClickZoom.enable();
    this.layer.clearLayers().remove();
    this.vtxLayer.clearLayers().remove();
    this.map.closePopup();
    this.draft = null;
  }

  setTool(tool) {
    this.tool = tool;
    const c = this.map.getContainer().classList;
    c.remove('hm-tool-draw', 'hm-tool-station', 'hm-tool-move');
    c.add(`hm-tool-${tool}`);
    this.onChange?.(this.draft, { tool });
  }

  snapshot() {
    this.undoStack.push(JSON.stringify({ segs: this.draft.segs, stations: this.draft.stations, active: this.active }));
    if (this.undoStack.length > 200) this.undoStack.shift();
  }

  undo() {
    const s = this.undoStack.pop();
    if (!s) return;
    const { segs, stations, active } = JSON.parse(s);
    this.draft.segs = segs;
    this.draft.stations = stations;
    this.active = Math.min(active, segs.length - 1);
    this.changed();
  }

  changed() {
    this.render();
    this.onChange?.(this.draft, {});
  }

  key(e) {
    if (e.target.closest('input, textarea, select')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); this.undo(); }
    else if (e.key === 'Escape') this.setTool('move');
    else if (e.key === 'Backspace' && this.tool === 'draw') { e.preventDefault(); this.removeLast(); }
  }

  px(ll) { return this.map.latLngToContainerPoint(L.latLng(ll[0], ll[1])); }

  // Nearest other line's station within the snap radius, for transfers.
  snapToStation(latlng) {
    const p = this.map.latLngToContainerPoint(latlng);
    let best = null, bestD = SNAP_PX;
    for (const s of [...this.otherStations(), ...this.draft.stations]) {
      const d = p.distanceTo(this.px([s.lat, s.lng]));
      if (d < bestD) { best = s; bestD = d; }
    }
    return best;
  }

  snapToDraft(latlng) {
    const segs = this.draft.segs.filter((s) => s.length >= 2);
    if (!segs.length) return null;
    const n = nearestOnSegs(segs, [latlng.lat, latlng.lng]);
    if (!n) return null;
    return this.map.latLngToContainerPoint(latlng).distanceTo(this.px(n.point)) < SNAP_PX ? n.point : null;
  }

  mapClick(e) {
    if (this.tool === 'draw') this.addVertex(e.latlng);
    else if (this.tool === 'station') this.addStation(e.latlng);
  }

  addVertex(latlng) {
    this.snapshot();
    const seg = this.draft.segs[this.active];
    const st = this.snapToStation(latlng);
    // The first point of a new branch joins the existing line if tapped near it.
    const onLine = !seg.length && this.draft.segs.length > 1 ? this.snapToDraft(latlng) : null;
    const p = st ? [st.lat, st.lng] : onLine || [latlng.lat, latlng.lng];
    seg.push([round5(p[0]), round5(p[1])]);
    this.changed();
  }

  removeLast() {
    const seg = this.draft.segs[this.active];
    if (!seg?.length) return;
    this.snapshot();
    seg.pop();
    this.changed();
  }

  addStation(latlng) {
    this.snapshot();
    const other = this.snapToStation(latlng);
    const onLine = this.snapToDraft(latlng);
    const p = other ? [other.lat, other.lng] : onLine || [latlng.lat, latlng.lng];
    const st = { lat: round5(p[0]), lng: round5(p[1]), name: other?.name || '' };
    if (!other && !st.name) st.name = `${this.t('station')} ${this.draft.stations.length + 1}`;
    this.draft.stations.push(st);
    this.changed();
    if (!other) this.stationMenu(this.draft.stations.length - 1, true);
  }

  newBranch() {
    if (!this.draft.segs[this.active].length) return;
    this.snapshot();
    this.draft.segs.push([]);
    this.active = this.draft.segs.length - 1;
    this.setTool('draw');
    this.changed();
  }

  reverse() {
    this.snapshot();
    this.draft.segs[this.active].reverse();
    this.changed();
  }

  deleteBranch() {
    if (this.draft.segs.length <= 1) {
      this.snapshot();
      this.draft.segs = [[]];
      this.active = 0;
    } else {
      this.snapshot();
      this.draft.segs.splice(this.active, 1);
      this.active = Math.max(0, this.active - 1);
    }
    this.changed();
  }

  // ---- drawing -----------------------------------------------------------------

  render() {
    this.layer.clearLayers();
    this.activeLines = [];
    const d = this.draft;
    d.segs.forEach((seg, i) => {
      if (seg.length < 2) return;
      const active = i === this.active;
      const casing = L.polyline(seg, { color: '#fff', weight: active ? 10 : 8, opacity: 0.9, interactive: false }).addTo(this.layer);
      const pl = L.polyline(seg, { color: d.color, weight: active ? 6 : 4, opacity: active ? 1 : 0.6, bubblingMouseEvents: false }).addTo(this.layer);
      if (active) this.activeLines = [casing, pl];
      pl.on('click', (e) => {
        if (this.tool === 'station') return this.addStation(e.latlng);
        if (this.tool === 'draw' && i === this.active) return this.addVertex(e.latlng);
        this.active = i;
        this.render();
      });
    });
    d.stations.forEach((s, i) => {
      const m = L.marker([s.lat, s.lng], {
        draggable: true,
        icon: L.divIcon({ className: 'hm-edit-station', html: `<span style="border-color:${d.color}"></span>`, iconSize: [18, 18] }),
        bubblingMouseEvents: false,
      }).addTo(this.layer);
      if (s.name) {
        const tip = document.createElement('span');
        tip.textContent = s.name;
        m.bindTooltip(tip, { direction: 'top', offset: [0, -8] });
      }
      m.on('dragstart', () => this.snapshot());
      m.on('dragend', (e) => {
        const ll = e.target.getLatLng();
        const snap = this.snapToStation(ll);
        const onLine = this.snapToDraft(ll);
        const p = snap && snap !== s ? [snap.lat, snap.lng] : onLine || [ll.lat, ll.lng];
        s.lat = round5(p[0]);
        s.lng = round5(p[1]);
        this.changed();
      });
      m.on('click', () => this.stationMenu(i));
    });
    this.renderVertices();
  }

  renderVertices() {
    this.vtxLayer.clearLayers();
    if (!this.draft) return;
    const seg = this.draft.segs[this.active] || [];
    const view = this.map.getBounds().pad(0.2);
    let shown = 0;
    seg.forEach((p, i) => {
      if (shown >= MAX_VERTEX_MARKERS || !view.contains(p)) return;
      shown++;
      const end = i === 0 || i === seg.length - 1;
      const m = L.marker(p, {
        draggable: true,
        icon: L.divIcon({ className: `hm-vtx${end ? ' hm-vtx-end' : ''}`, iconSize: [12, 12] }),
        bubblingMouseEvents: false,
        zIndexOffset: 500,
      }).addTo(this.vtxLayer);
      m.on('dragstart', () => this.snapshot());
      m.on('drag', (e) => {
        const ll = e.target.getLatLng();
        seg[i] = [ll.lat, ll.lng];
        this.activeLines.forEach((l) => l.setLatLngs(seg));
      });
      m.on('dragend', (e) => {
        const ll = e.target.getLatLng();
        const st = this.snapToStation(ll);
        seg[i] = st ? [st.lat, st.lng] : [round5(ll.lat), round5(ll.lng)];
        this.changed();
      });
      m.on('click', () => (this.tool === 'station' ? this.addStation(L.latLng(p[0], p[1])) : this.vertexMenu(i)));
      m.on('contextmenu', () => this.deleteVertex(i));
    });
    // "+" handles halfway along each piece: drag one to bend the line there.
    for (let i = 1; i < seg.length && shown < MAX_VERTEX_MARKERS; i++) {
      const a = seg[i - 1], b = seg[i];
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (!view.contains(mid) || this.px(a).distanceTo(this.px(b)) < 40) continue;
      shown++;
      const m = L.marker(mid, { draggable: true, icon: L.divIcon({ className: 'hm-mid', iconSize: [12, 12] }), bubblingMouseEvents: false, zIndexOffset: 400 }).addTo(this.vtxLayer);
      m.on('dragstart', () => { this.snapshot(); seg.splice(i, 0, mid); });
      m.on('drag', (e) => {
        const ll = e.target.getLatLng();
        seg[i] = [ll.lat, ll.lng];
        this.activeLines.forEach((l) => l.setLatLngs(seg));
      });
      m.on('dragend', (e) => {
        const ll = e.target.getLatLng();
        seg[i] = [round5(ll.lat), round5(ll.lng)];
        this.changed();
      });
    }
  }

  deleteVertex(i) {
    this.snapshot();
    this.draft.segs[this.active].splice(i, 1);
    this.map.closePopup();
    this.changed();
  }

  vertexMenu(i) {
    const seg = this.draft.segs[this.active];
    const box = document.createElement('div');
    box.className = 'hm-popmenu';
    const del = button(this.t('deletePoint'), () => this.deleteVertex(i));
    box.append(del);
    if (i === 0 || i === seg.length - 1) {
      box.append(button(this.t('continueHere'), () => {
        if (i === 0) seg.reverse();
        this.map.closePopup();
        this.setTool('draw');
        this.render();
      }));
    }
    L.popup({ closeButton: false, offset: [0, -4] }).setLatLng(seg[i]).setContent(box).openOn(this.map);
  }

  stationMenu(i, focus = false) {
    const s = this.draft.stations[i];
    const box = document.createElement('div');
    box.className = 'hm-popmenu';
    const input = document.createElement('input');
    input.value = s.name;
    input.maxLength = 60;
    input.placeholder = this.t('stationName');
    input.addEventListener('input', () => { s.name = input.value; });
    input.addEventListener('change', () => this.changed());
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { this.map.closePopup(); this.changed(); } });
    box.append(input, button(this.t('deleteStation'), () => {
      this.snapshot();
      this.draft.stations.splice(i, 1);
      this.map.closePopup();
      this.changed();
    }));
    L.popup({ closeButton: false, offset: [0, -6] }).setLatLng([s.lat, s.lng]).setContent(box).openOn(this.map);
    if (focus) setTimeout(() => { input.focus(); input.select(); }, 50);
  }
}

function button(label, fn) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
  return b;
}
