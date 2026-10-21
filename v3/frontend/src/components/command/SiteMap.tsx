import type { CSSProperties } from "react";
import type { Camera, Location } from "../../types";

export type MapAlert = {
  locationId?: string;
  cameraId?: string;
  high: boolean;
};

// Camera dots are schematic: a deterministic grid inside the zone, not real positions.
function dotPosition(i: number, n: number) {
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const col = i % cols;
  const row = Math.floor(i / cols);
  return {
    left: `${((col + 1) / (cols + 1)) * 100}%`,
    top: `${((row + 1) / (rows + 1)) * 100}%`,
  };
}

export function SiteMap({
  locations,
  cameras,
  alerts,
  hoveredLocation,
  onHoverLocation,
  onZoneClick,
  cameraLabel,
}: {
  locations: Location[];
  cameras: Camera[];
  alerts: MapAlert[];
  hoveredLocation: string | null;
  onHoverLocation: (id: string | null) => void;
  onZoneClick: (locationId: string) => void;
  cameraLabel: (camera: Camera) => string;
}) {
  const zones = locations.filter((l) => l.map_area?.length === 4);
  return (
    <section className="cc-map" aria-labelledby="cc-map-title">
      <div className="cc-map-head">
        <h2 id="cc-map-title" className="cc-label">
          Serenia City · Site
        </h2>
        <span className="cc-label">{cameras.length} cameras</span>
      </div>
      <div className="cc-map-canvas">
        {zones.map((zone) => {
          const [x, y, w, h] = zone.map_area;
          const zoneAlerts = alerts.filter((a) => a.locationId === zone.id);
          const count = zoneAlerts.length;
          const high = zoneAlerts.some((a) => a.high);
          const zoneCameras = cameras.filter((c) => c.location_id === zone.id);
          const style = {
            left: `${x}%`,
            top: `${y}%`,
            width: `${w}%`,
            height: `${h}%`,
          } as CSSProperties;
          return (
            <button
              key={zone.id}
              type="button"
              className={
                "cc-zone" +
                (count ? " has-alerts" : "") +
                (hoveredLocation === zone.id ? " is-lit" : "") +
                (hoveredLocation && hoveredLocation !== zone.id ? " is-dim" : "")
              }
              style={style}
              aria-label={`${zone.name}, ${count} pending alert${count === 1 ? "" : "s"}`}
              onMouseEnter={() => onHoverLocation(zone.id)}
              onMouseLeave={() => onHoverLocation(null)}
              onFocus={() => onHoverLocation(zone.id)}
              onBlur={() => onHoverLocation(null)}
              onClick={() => count && onZoneClick(zone.id)}
            >
              <span className="cc-zone-name">{zone.name}</span>
              {count > 0 && (
                <span className={high ? "cc-zone-count is-high" : "cc-zone-count"}>
                  {count}
                </span>
              )}
              {zoneCameras.map((camera, i) => {
                const alerting = alerts.some((a) => a.cameraId === camera.id);
                return (
                  <span
                    key={camera.id}
                    className={alerting ? "cc-dot is-alerting" : "cc-dot"}
                    style={dotPosition(i, zoneCameras.length)}
                    title={cameraLabel(camera)}
                  />
                );
              })}
            </button>
          );
        })}
      </div>
      <p className="cc-map-foot">
        Schematic from your site zones · amber = pending alerts
      </p>
    </section>
  );
}
