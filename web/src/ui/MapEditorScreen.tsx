import { useEffect, useMemo, useRef, useState } from "react";
import type { MapObjectType, ZoneKind } from "../types/mapConfig";
import {
  AuthoredMap,
  AuthoredObject,
  emptyMap,
  loadCustomMap,
  newUid,
  saveCustomMap,
  toRawConfig,
} from "../domain/mapAuthoring";
import { normalizeZoneKind } from "../domain/zones";
import { PREFABS, groupPrefabs } from "../domain/prefabs";
import { drawObject } from "./mapDraw";
import { MAP_CHOICES } from "../state/syncleStore";

const GRID = 20;

/** Editable zone kinds shown in the editor. `none` is domain-level only
 *  (point outside every zone) and can never be authored. */
const ZONE_KIND_OPTIONS: { value: ZoneKind; label: string }[] = [
  { value: "silent", label: "Silent (study)" },
  { value: "discussion", label: "Discussion" },
  { value: "rest", label: "Rest (lounge)" },
];

export interface MapEditorScreenProps {
  onClose: () => void;
}

type Tool = "select" | MapObjectType;

interface DragState {
  startWorldX: number;
  startWorldY: number;
  curWorldX: number;
  curWorldY: number;
}

export function MapEditorScreen({ onClose }: MapEditorScreenProps) {
  const [map, setMap] = useState<AuthoredMap>(() => loadCustomMap() ?? emptyMap());
  const [tool, setTool] = useState<Tool>("wall");
  const [selectedUid, setSelectedUid] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [status, setStatus] = useState<string>("");
  // Kind stamped onto newly created zones (dropdown next to the toolbar when
  // the zone tool is active). Defaults to "discussion" = pre-M1 behavior.
  const [newZoneKind, setNewZoneKind] = useState<ZoneKind>("discussion");

  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Compute a "fit to screen" viewport so the whole authored map is visible.
  const fitToScreen = (w: number, h: number) => {
    const padding = 40;
    const scale = Math.min(
      (w - padding * 2) / map.width,
      (h - padding * 2) / map.height,
    );
    const offsetX = (w - map.width * scale) / 2;
    const offsetY = (h - map.height * scale) / 2;
    return { scale, offsetX, offsetY };
  };

  const screenToWorld = (sx: number, sy: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const cx = sx - rect.left;
    const cy = sy - rect.top;
    const vp = fitToScreen(rect.width, rect.height);
    return {
      x: (cx - vp.offsetX) / vp.scale,
      y: (cy - vp.offsetY) / vp.scale,
    };
  };

  const snap = (v: number) => Math.round(v / GRID) * GRID;

  // Render loop. Editor is mostly static but we want to redraw on every
  // change (drag preview, selection move) so a simple raf is fine.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    let raf = 0;

    function resize() {
      if (!canvas) return;
      canvas.width = Math.floor(canvas.clientWidth * dpr);
      canvas.height = Math.floor(canvas.clientHeight * dpr);
    }
    resize();
    window.addEventListener("resize", resize);

    const draw = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        raf = requestAnimationFrame(draw);
        return;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const w = canvas.width / dpr;
      const h = canvas.height / dpr;
      const vp = fitToScreen(w, h);

      // Editor backdrop
      ctx.fillStyle = "#0e1116";
      ctx.fillRect(0, 0, w, h);

      // Floor
      ctx.fillStyle = map.backgroundColor;
      ctx.fillRect(vp.offsetX, vp.offsetY, map.width * vp.scale, map.height * vp.scale);

      // Grid overlay
      ctx.save();
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let gx = 0; gx <= map.width; gx += GRID) {
        const sx = gx * vp.scale + vp.offsetX;
        ctx.moveTo(sx, vp.offsetY);
        ctx.lineTo(sx, vp.offsetY + map.height * vp.scale);
      }
      for (let gy = 0; gy <= map.height; gy += GRID) {
        const sy = gy * vp.scale + vp.offsetY;
        ctx.moveTo(vp.offsetX, sy);
        ctx.lineTo(vp.offsetX + map.width * vp.scale, sy);
      }
      ctx.stroke();
      ctx.restore();

      // Map outline
      ctx.strokeStyle = "rgba(80,200,120,0.4)";
      ctx.lineWidth = 2;
      ctx.strokeRect(vp.offsetX, vp.offsetY, map.width * vp.scale, map.height * vp.scale);

      // Authored objects
      for (const obj of map.objects) {
        const x = obj.x * vp.scale + vp.offsetX;
        const y = obj.y * vp.scale + vp.offsetY;
        const ww = obj.width * vp.scale;
        const hh = obj.height * vp.scale;
        drawObject(ctx, obj, x, y, ww, hh, 0, false, vp.scale);

        if (obj.uid === selectedUid) {
          ctx.save();
          ctx.strokeStyle = "#5AC8FA";
          ctx.lineWidth = 2;
          ctx.setLineDash([6, 4]);
          ctx.strokeRect(x - 3, y - 3, ww + 6, hh + 6);
          ctx.restore();
        }
      }

      // Drag preview rectangle
      if (drag && tool !== "select") {
        const x0 = Math.min(drag.startWorldX, drag.curWorldX);
        const y0 = Math.min(drag.startWorldY, drag.curWorldY);
        const ww = Math.abs(drag.curWorldX - drag.startWorldX);
        const hh = Math.abs(drag.curWorldY - drag.startWorldY);
        ctx.save();
        ctx.fillStyle = "rgba(90,200,250,0.18)";
        ctx.fillRect(
          x0 * vp.scale + vp.offsetX,
          y0 * vp.scale + vp.offsetY,
          ww * vp.scale,
          hh * vp.scale,
        );
        ctx.strokeStyle = "rgba(90,200,250,0.9)";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(
          x0 * vp.scale + vp.offsetX,
          y0 * vp.scale + vp.offsetY,
          ww * vp.scale,
          hh * vp.scale,
        );
        ctx.restore();
      }

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      window.removeEventListener("resize", resize);
      cancelAnimationFrame(raf);
    };
  }, [map, selectedUid, drag, tool]);

  // Delete key removes selected object.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "Delete" || e.key === "Backspace") && selectedUid) {
        // Don't fire while editing a form field
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
        e.preventDefault();
        setMap((m) => ({ ...m, objects: m.objects.filter((o) => o.uid !== selectedUid) }));
        setSelectedUid(null);
      } else if (e.key === "Escape") {
        setSelectedUid(null);
        setDrag(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedUid]);

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const w = screenToWorld(e.clientX, e.clientY);
    if (tool === "select") {
      // Reverse hit-test so top-drawn objects win.
      const hit = [...map.objects].reverse().find((o) =>
        w.x >= o.x && w.x <= o.x + o.width && w.y >= o.y && w.y <= o.y + o.height,
      );
      setSelectedUid(hit?.uid ?? null);
      return;
    }
    setSelectedUid(null);
    setDrag({
      startWorldX: snap(w.x),
      startWorldY: snap(w.y),
      curWorldX: snap(w.x),
      curWorldY: snap(w.y),
    });
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!drag) return;
    const w = screenToWorld(e.clientX, e.clientY);
    setDrag({ ...drag, curWorldX: snap(w.x), curWorldY: snap(w.y) });
  };

  const handleMouseUp = () => {
    if (!drag || tool === "select") {
      setDrag(null);
      return;
    }
    const x = Math.min(drag.startWorldX, drag.curWorldX);
    const y = Math.min(drag.startWorldY, drag.curWorldY);
    const width = Math.abs(drag.curWorldX - drag.startWorldX);
    const height = Math.abs(drag.curWorldY - drag.startWorldY);
    setDrag(null);
    if (width < GRID || height < GRID) {
      setStatus("Drag too small — release with at least 1 grid cell");
      return;
    }
    const obj: AuthoredObject = {
      uid: newUid(),
      type: tool,
      x,
      y,
      width,
      height,
    };
    if (tool === "table") {
      // Tables need stable ids for the table-join system. Auto-assign one
      // that's unique within the current map.
      const existing = new Set(map.objects.filter((o) => o.type === "table").map((o) => o.id));
      let n = 1;
      while (existing.has(`table-${n}`)) n++;
      obj.id = `table-${n}`;
      obj.label = `Table ${n}`;
    } else if (tool === "note") {
      // Seed a default body so the note is interactable immediately.
      obj.label = "Note";
      obj.text = "Type your note text in the inspector →";
    } else if (tool === "zone") {
      // Zones need a human-readable label so they show up in the "Who's
      // where" sidebar with a meaningful name. Stamp the acoustic kind the
      // author picked in the toolbar dropdown (defaults to "discussion").
      const existing = new Set(
        map.objects.filter((o) => o.type === "zone").map((o) => o.label),
      );
      let n = 1;
      while (existing.has(`Zone ${n}`)) n++;
      obj.label = `Zone ${n}`;
      obj.id = `zone-${n}`;
      obj.kind = newZoneKind;
    } else if (tool === "portal") {
      // Portals need a destination map URL. Default to the first non-custom
      // map; user changes it in the inspector. Without a destination the
      // portal renders but never teleports.
      const firstMap = MAP_CHOICES[0];
      obj.label = "Portal";
      obj.destination = {
        mapUrl: firstMap.url,
        label: firstMap.label,
        spawn: { ...firstMap.spawn },
      };
    } else if (tool === "board") {
      // PR boards default to no repo; the BoardModal renders a "Connect
      // GitHub" prompt until the author sets one in the inspector.
      obj.label = "PR board";
    }
    setMap((m) => ({ ...m, objects: [...m.objects, obj] }));
    setSelectedUid(obj.uid);
    setStatus("");
  };

  const selected = useMemo(
    () => map.objects.find((o) => o.uid === selectedUid) ?? null,
    [map.objects, selectedUid],
  );

  const updateSelected = (patch: Partial<AuthoredObject>) => {
    if (!selectedUid) return;
    setMap((m) => ({
      ...m,
      objects: m.objects.map((o) => (o.uid === selectedUid ? { ...o, ...patch } : o)),
    }));
  };

  const handleSave = () => {
    saveCustomMap(map);
    setStatus("Saved. Pick \"Custom (your edits)\" on the join screen.");
  };

  const handleExport = async () => {
    const json = JSON.stringify(toRawConfig(map), null, 2);
    try {
      await navigator.clipboard.writeText(json);
      setStatus(`Copied ${json.length} bytes of JSON to clipboard`);
    } catch {
      setStatus("Clipboard blocked; opening JSON in alert window");
      alert(json);
    }
  };

  const handleClear = () => {
    if (!confirm("Clear all objects?")) return;
    setMap((m) => ({ ...m, objects: [] }));
    setSelectedUid(null);
  };

  return (
    <div className="editor">
      <div className="editor-toolbar">
        <strong style={{ marginRight: 12 }}>Map editor</strong>

        <button
          className={tool === "select" ? "active" : ""}
          onClick={() => setTool("select")}
          title="Select / move objects"
        >Select</button>

        {groupPrefabs(PREFABS).map((group) => (
          <span key={group.category} className="editor-toolbar-group">
            <span className="editor-toolbar-group-label">{group.category}</span>
            {group.items.map((p) => (
              <button
                key={p.type}
                className={tool === p.type ? "active" : ""}
                onClick={() => setTool(p.type)}
                title={`Place ${p.label}`}
              >{p.label}</button>
            ))}
          </span>
        ))}

        <span className="spacer" />

        {tool === "zone" && (
          <label className="editor-toolbar-kind" title="Acoustic policy for newly drawn zones">
            Zone kind
            <select
              value={newZoneKind}
              onChange={(e) => setNewZoneKind(e.target.value as ZoneKind)}
            >
              {ZONE_KIND_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
        )}

        <button onClick={handleSave}>Save</button>
        <button onClick={handleExport}>Export JSON</button>
        <button onClick={handleClear}>Clear</button>
        <button onClick={onClose}>Close</button>
      </div>

      <div className="editor-main">
        <canvas
          ref={canvasRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={() => setDrag(null)}
        />

        <aside className="editor-side">
          <div className="editor-section">
            <h3>Map</h3>
            <label>
              Name
              <input
                value={map.name}
                onChange={(e) => setMap({ ...map, name: e.target.value })}
              />
            </label>
            <label>
              Width
              <input
                type="number"
                min={100}
                max={4000}
                value={map.width}
                onChange={(e) => setMap({ ...map, width: Number(e.target.value) || 0 })}
              />
            </label>
            <label>
              Height
              <input
                type="number"
                min={100}
                max={4000}
                value={map.height}
                onChange={(e) => setMap({ ...map, height: Number(e.target.value) || 0 })}
              />
            </label>
            <label>
              Floor color
              <input
                type="color"
                value={map.backgroundColor}
                onChange={(e) => setMap({ ...map, backgroundColor: e.target.value })}
              />
            </label>
            <small className="hint">{map.objects.length} object(s) · grid {GRID}</small>
          </div>

          <div className="editor-section">
            <h3>Selected</h3>
            {selected ? (
              <>
                <div className="row"><strong>type</strong> <span>{selected.type}</span></div>
                {selected.type === "table" && (
                  <label>
                    Table id
                    <input
                      value={selected.id ?? ""}
                      onChange={(e) => updateSelected({ id: e.target.value })}
                    />
                  </label>
                )}
                <label>
                  Label
                  <input
                    value={selected.label ?? ""}
                    onChange={(e) => updateSelected({ label: e.target.value })}
                  />
                </label>
                {selected.type === "zone" && (
                  <label>
                    Zone kind
                    <select
                      value={normalizeZoneKind(selected.kind)}
                      onChange={(e) =>
                        updateSelected({ kind: e.target.value as ZoneKind })
                      }
                    >
                      {ZONE_KIND_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </label>
                )}
                {selected.type === "note" && (
                  <label>
                    Note text
                    <textarea
                      rows={6}
                      value={selected.text ?? ""}
                      onChange={(e) => updateSelected({ text: e.target.value })}
                    />
                  </label>
                )}
                {selected.type === "portal" && (
                  <>
                    <label>
                      Destination map
                      <select
                        value={selected.destination?.mapUrl ?? ""}
                        onChange={(e) => {
                          const choice = MAP_CHOICES.find((m) => m.url === e.target.value);
                          if (!choice) return;
                          updateSelected({
                            destination: {
                              mapUrl: choice.url,
                              label: choice.label,
                              spawn: { ...choice.spawn },
                            },
                          });
                        }}
                      >
                        {MAP_CHOICES.map((m) => (
                          <option key={m.id} value={m.url}>{m.label}</option>
                        ))}
                      </select>
                    </label>
                    <small className="hint">
                      Walking into this portal teleports the local player only.
                      Peers stay where they are until they walk through too.
                    </small>
                  </>
                )}
                {selected.type === "board" && (
                  <>
                    <label>
                      GitHub repo
                      <input
                        value={selected.repo ?? ""}
                        placeholder="owner/name"
                        onChange={(e) => updateSelected({ repo: e.target.value })}
                      />
                    </label>
                    <small className="hint">
                      Lists 10 most recently updated open PRs via the public
                      GitHub API (60 req/hour without auth).
                    </small>
                  </>
                )}
                <div className="row">
                  <label>
                    x
                    <input
                      type="number"
                      value={selected.x}
                      onChange={(e) => updateSelected({ x: Number(e.target.value) || 0 })}
                    />
                  </label>
                  <label>
                    y
                    <input
                      type="number"
                      value={selected.y}
                      onChange={(e) => updateSelected({ y: Number(e.target.value) || 0 })}
                    />
                  </label>
                </div>
                <div className="row">
                  <label>
                    w
                    <input
                      type="number"
                      value={selected.width}
                      onChange={(e) => updateSelected({ width: Number(e.target.value) || 0 })}
                    />
                  </label>
                  <label>
                    h
                    <input
                      type="number"
                      value={selected.height}
                      onChange={(e) => updateSelected({ height: Number(e.target.value) || 0 })}
                    />
                  </label>
                </div>
                <button onClick={() => {
                  setMap((m) => ({ ...m, objects: m.objects.filter((o) => o.uid !== selected.uid) }));
                  setSelectedUid(null);
                }}>Delete</button>
              </>
            ) : (
              <small className="hint">Pick the Select tool and click an object.</small>
            )}
          </div>

          <div className="editor-section">
            <h3>How it works</h3>
            <small className="hint">
              Pick a tool, then drag on the canvas to place a rect. Walls, tables,
              desks, plants and cabinets block movement; rugs, chairs and doors do not.
              Tables auto-get ids so the sit-at-table flow works. Save, then on the
              join screen pick &quot;Custom (your edits)&quot;.
            </small>
          </div>

          {status && <div className="editor-status">{status}</div>}
        </aside>
      </div>
    </div>
  );
}
