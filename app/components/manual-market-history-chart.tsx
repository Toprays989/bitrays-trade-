"use client";

import { useRef, useState } from "react";

export type ManualMarketHistoryPoint = {
  time: number;
  price: number;
  volumeUsdt: number;
  openInterestUsdt: number | null;
};

type ManualMarketHistoryChartProps = {
  symbol: string;
  points: ManualMarketHistoryPoint[];
  loading: boolean;
  error: string | null;
  updatedAt: string | null;
};

const WIDTH = 1_200;
const LEFT = 72;
const RIGHT = 78;
const PLOT_WIDTH = WIDTH - LEFT - RIGHT;
const PLOT_TOP = 22;
const PLOT_HEIGHT = 226;
const PLOT_BOTTOM = PLOT_TOP + PLOT_HEIGHT;
const NODE_TOOLTIP_WIDTH = 178;
const NODE_TOOLTIP_HEIGHT = 66;
const VISIBLE_POINT_COUNT = 96;

function finiteValues(values: Array<number | null>) {
  return values.filter(
    (value): value is number =>
      value !== null && Number.isFinite(value),
  );
}

function range(values: Array<number | null>) {
  const finite = finiteValues(values);
  if (!finite.length) return { min: 0, max: 1 };
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  if (min === max) return { min: min * 0.99, max: max * 1.01 || 1 };
  return { min, max };
}

function yScale(value: number, min: number, max: number, top: number, height: number) {
  return top + height - ((value - min) / Math.max(max - min, Number.EPSILON)) * height;
}

function linePath(
  points: ManualMarketHistoryPoint[],
  value: (point: ManualMarketHistoryPoint) => number | null,
  top: number,
  height: number,
) {
  const values = points.map(value);
  const { min, max } = range(values);
  let started = false;
  const path = points
    .map((point, index) => {
      const current = value(point);
      if (current === null || !Number.isFinite(current)) return "";
      const x =
        LEFT +
        (index / Math.max(points.length - 1, 1)) * PLOT_WIDTH;
      const y = yScale(current, min, max, top, height);
      const command = started ? "L" : "M";
      started = true;
      return `${command}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .filter(Boolean)
    .join(" ");
  return { path, min, max };
}

function compact(value: number | null, digits = 2) {
  if (value === null || !Number.isFinite(value)) return "--";
  if (Math.abs(value) >= 100_000_000)
    return `${(value / 100_000_000).toFixed(digits)}亿`;
  if (Math.abs(value) >= 10_000)
    return `${(value / 10_000).toFixed(digits)}万`;
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 8 });
}

export function ManualMarketHistoryChart({
  symbol,
  points,
  loading,
  error,
  updatedAt,
}: ManualMarketHistoryChartProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [viewport, setViewport] = useState({ symbol: "", offset: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startOffset: number;
  } | null>(null);
  const maxHistoryOffset = Math.max(0, points.length - VISIBLE_POINT_COUNT);
  const historyOffset =
    viewport.symbol === symbol
      ? Math.min(maxHistoryOffset, Math.max(0, viewport.offset))
      : 0;
  const windowStart = Math.max(0, maxHistoryOffset - historyOffset);
  const visiblePoints = points.slice(
    windowStart,
    windowStart + VISIBLE_POINT_COUNT,
  );
  const price = linePath(
    visiblePoints,
    (point) => point.price,
    PLOT_TOP,
    PLOT_HEIGHT,
  );
  const interest = linePath(
    visiblePoints,
    (point) => point.openInterestUsdt,
    PLOT_TOP,
    PLOT_HEIGHT,
  );
  const volumeMax = Math.max(
    ...visiblePoints.map((point) => point.volumeUsdt),
    1,
  );
  const latestIndex = Math.max(visiblePoints.length - 1, 0);
  const activeIndex =
    hoveredIndex === null
      ? latestIndex
      : Math.min(latestIndex, Math.max(0, hoveredIndex));
  const activePoint = visiblePoints[activeIndex] ?? visiblePoints.at(-1);
  const activeGlobalIndex = windowStart + activeIndex;
  const activeX =
    LEFT +
    (activeIndex / Math.max(visiblePoints.length - 1, 1)) * PLOT_WIDTH;
  const activePriceY = activePoint
    ? yScale(
        activePoint.price,
        price.min,
        price.max,
        PLOT_TOP,
        PLOT_HEIGHT,
      )
    : 0;
  const activeInterestY =
    activePoint?.openInterestUsdt !== null &&
    activePoint?.openInterestUsdt !== undefined
      ? yScale(
          activePoint.openInterestUsdt,
          interest.min,
          interest.max,
          PLOT_TOP,
          PLOT_HEIGHT,
      )
      : null;
  const activeVolumeY = activePoint
    ? PLOT_BOTTOM -
      (Math.max(0, activePoint.volumeUsdt) / volumeMax) * PLOT_HEIGHT
    : null;
  const nodeTooltipX =
    activeX - NODE_TOOLTIP_WIDTH - 12 >= LEFT
      ? activeX - NODE_TOOLTIP_WIDTH - 12
      : activeX + 12;
  const nodeTooltipY = Math.min(
    PLOT_BOTTOM - NODE_TOOLTIP_HEIGHT - 4,
    Math.max(PLOT_TOP + 4, activePriceY - NODE_TOOLTIP_HEIGHT / 2),
  );
  const tickIndexes = [0, 24, 48, 72, visiblePoints.length - 1]
    .filter((index) => index >= 0 && index < visiblePoints.length)
    .filter((index, position, indexes) => indexes.indexOf(index) === position);

  function stopDragging(pointerId: number) {
    if (dragRef.current?.pointerId !== pointerId) return;
    dragRef.current = null;
    setIsDragging(false);
  }

  return (
    <section className="panel manual-market-history">
        <div className="manual-market-history-head">
        <div>
          <h2>{symbol || "未选择合约"} · 96 小时走势</h2>
          <p>30 分钟一个节点 · 单屏 48 小时 · 按住图表左右拖动回看完整 96 小时</p>
        </div>
        <div className="manual-market-history-summary">
          <span className="node-time">
            {activePoint
              ? new Date(activePoint.time).toLocaleString("zh-CN", {
                  month: "2-digit",
                  day: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                  hour12: false,
                })
              : "--"}
            {activeGlobalIndex === points.length - 1 && points.length > 0 && (
              <em>当前节点</em>
            )}
          </span>
          <span>
            价格 <b>{compact(activePoint?.price ?? null)}</b>
          </span>
          <span>
            持仓价值{" "}
            <b>{compact(activePoint?.openInterestUsdt ?? null)} USDT</b>
          </span>
          <span>
            30m 成交额 <b>{compact(activePoint?.volumeUsdt ?? null)} USDT</b>
          </span>
          {updatedAt && (
            <small>
              更新{" "}
              {new Date(updatedAt).toLocaleTimeString("zh-CN", {
                hour12: false,
              })}
            </small>
          )}
        </div>
      </div>

      {!symbol ? (
        <div className="empty">选择合约后显示最近 96 小时走势</div>
      ) : loading ? (
        <div className="empty">正在读取 96 小时合约数据…</div>
      ) : error ? (
        <div className="empty negative">{error}</div>
      ) : points.length === 0 ? (
        <div className="empty">该合约暂无 96 小时历史数据</div>
      ) : (
        <div
          className={`manual-market-history-chart${isDragging ? " is-dragging" : ""}`}
        >
          <div className="manual-market-history-legend">
            <span className="price">价格</span>
            <span className="interest">持仓价值</span>
            <span className="volume">成交额</span>
          </div>
          <svg
            viewBox={`0 0 ${WIDTH} 300`}
            role="img"
            aria-label={`${symbol} 最近96小时价格、持仓价值和成交额走势图，可左右拖动查看`}
            onPointerDown={(event) => {
              if (maxHistoryOffset === 0) return;
              dragRef.current = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startOffset: historyOffset,
              };
              event.currentTarget.setPointerCapture(event.pointerId);
              setHoveredIndex(null);
              setIsDragging(true);
            }}
            onPointerMove={(event) => {
              const bounds = event.currentTarget.getBoundingClientRect();
              const drag = dragRef.current;
              if (drag?.pointerId === event.pointerId) {
                const movedPoints = Math.round(
                  ((event.clientX - drag.startX) /
                    Math.max(bounds.width, 1)) *
                    VISIBLE_POINT_COUNT,
                );
                setViewport({
                  symbol,
                  offset: Math.min(
                    maxHistoryOffset,
                    Math.max(0, drag.startOffset + movedPoints),
                  ),
                });
                return;
              }
              const viewX =
                ((event.clientX - bounds.left) / Math.max(bounds.width, 1)) *
                WIDTH;
              const ratio = Math.min(
                1,
                Math.max(0, (viewX - LEFT) / PLOT_WIDTH),
              );
              setHoveredIndex(
                Math.round(ratio * Math.max(visiblePoints.length - 1, 0)),
              );
            }}
            onPointerUp={(event) => stopDragging(event.pointerId)}
            onPointerCancel={(event) => stopDragging(event.pointerId)}
            onPointerLeave={() => {
              if (!dragRef.current) setHoveredIndex(null);
            }}
          >
            {[PLOT_TOP, 78, 135, 191, PLOT_BOTTOM].map((y) => (
              <line
                key={y}
                x1={LEFT}
                x2={WIDTH - RIGHT}
                y1={y}
                y2={y}
                className="grid"
              />
            ))}
            <text x="8" y="17" className="price-axis-label">价格</text>
            <text x="8" y={PLOT_TOP + 13}>{compact(price.max)}</text>
            <text x="8" y={PLOT_BOTTOM}>{compact(price.min)}</text>
            <text
              x={WIDTH - 8}
              y="17"
              textAnchor="end"
              className="interest-axis-label"
            >
              持仓价值
            </text>
            <text x={WIDTH - 8} y={PLOT_TOP + 13} textAnchor="end">
              {compact(interest.max)}
            </text>
            <text x={WIDTH - 8} y={PLOT_BOTTOM} textAnchor="end">
              {compact(interest.min)}
            </text>
            <text x="8" y={PLOT_BOTTOM - 8} className="volume-axis-label">
              成交额峰值 {compact(volumeMax)}
            </text>
            {visiblePoints.map((point, index) => {
              const x =
                LEFT +
                (index / Math.max(visiblePoints.length - 1, 1)) * PLOT_WIDTH;
              const barWidth = Math.max(PLOT_WIDTH / visiblePoints.length - 3, 2);
              const barHeight =
                (point.volumeUsdt / volumeMax) * PLOT_HEIGHT;
              return (
                <rect
                  key={point.time}
                  x={x - barWidth / 2}
                  y={PLOT_BOTTOM - barHeight}
                  width={barWidth}
                  height={barHeight}
                  rx="1.5"
                  className="volume-bar"
                  fill="rgba(107, 124, 255, 0.2)"
                />
              );
            })}
            <path
              d={price.path}
              className="price-line"
              fill="none"
              stroke="var(--cyan, #18cdbb)"
              strokeWidth="2.5"
            />
            <path
              d={interest.path}
              className="interest-line"
              fill="none"
              stroke="var(--amber, #f3a531)"
              strokeWidth="2.5"
            />
            {activePoint && (
              <g className="active-node" aria-hidden="true">
                <line
                  x1={activeX}
                  x2={activeX}
                  y1={PLOT_TOP}
                  y2={PLOT_BOTTOM}
                  className="node-crosshair"
                />
                <circle
                  cx={activeX}
                  cy={activePriceY}
                  r="5"
                  className="node-dot price"
                />
                {activeInterestY !== null && (
                  <circle
                    cx={activeX}
                    cy={activeInterestY}
                    r="5"
                    className="node-dot interest"
                  />
                )}
                {activeVolumeY !== null && (
                  <circle
                    cx={activeX}
                    cy={activeVolumeY}
                    r="4"
                    className="node-dot volume"
                  />
                )}
                <g className="node-tooltip">
                  <rect
                    x={nodeTooltipX}
                    y={nodeTooltipY}
                    width={NODE_TOOLTIP_WIDTH}
                    height={NODE_TOOLTIP_HEIGHT}
                    rx="7"
                    className="node-tooltip-box"
                  />
                  <text
                    x={nodeTooltipX + 10}
                    y={nodeTooltipY + 17}
                    className="node-tooltip-price"
                  >
                    价格　{compact(activePoint.price)}
                  </text>
                  <text
                    x={nodeTooltipX + 10}
                    y={nodeTooltipY + 36}
                    className="node-tooltip-interest"
                  >
                    持仓　{compact(activePoint.openInterestUsdt)} USDT
                  </text>
                  <text
                    x={nodeTooltipX + 10}
                    y={nodeTooltipY + 55}
                    className="node-tooltip-volume"
                  >
                    成交额　{compact(activePoint.volumeUsdt)} USDT
                  </text>
                </g>
              </g>
            )}
            {tickIndexes.map((index) => {
              const point = visiblePoints[index];
              const x =
                LEFT +
                (index / Math.max(visiblePoints.length - 1, 1)) * PLOT_WIDTH;
              return (
                <g key={`tick-${point.time}`}>
                  <line x1={x} x2={x} y1="274" y2="280" className="axis" />
                  <text x={x} y="294" textAnchor="middle">
                    {new Date(point.time).toLocaleString("zh-CN", {
                      month: "2-digit",
                      day: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: false,
                    })}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      )}
    </section>
  );
}
