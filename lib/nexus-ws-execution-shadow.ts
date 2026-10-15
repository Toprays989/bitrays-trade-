export type NexusOrderIntent = {
  symbol: string;
  side: "BUY" | "SELL";
  positionSide?: "BOTH" | "LONG" | "SHORT";
  type: "MARKET" | "LIMIT";
  quantity: number;
  price?: number | null;
  timeInForce?: "GTC" | "FOK";
  clientOrderId: string;
  reduceOnly?: boolean;
};

export type NexusWsUnsignedRequest = {
  id: string;
  method: "order.place" | "order.cancel" | "order.modify";
  params: Record<string, string | number | boolean>;
  priority: "EMERGENCY" | "NORMAL";
};

export function buildNexusWsOrderPlaceShadow(
  intent: NexusOrderIntent,
  timestamp: number,
): NexusWsUnsignedRequest {
  if (
    !intent.symbol ||
    !intent.clientOrderId ||
    !Number.isFinite(intent.quantity) ||
    intent.quantity <= 0
  )
    throw new Error("WS影子订单参数无效");
  const params: Record<string, string | number | boolean> = {
    symbol: intent.symbol.toUpperCase(),
    side: intent.side,
    type: intent.type,
    quantity: intent.quantity,
    newClientOrderId: intent.clientOrderId,
    timestamp,
  };
  if (intent.positionSide && intent.positionSide !== "BOTH")
    params.positionSide = intent.positionSide;
  if (intent.reduceOnly) params.reduceOnly = true;
  if (intent.type === "LIMIT") {
    if (!Number.isFinite(intent.price) || Number(intent.price) <= 0)
      throw new Error("WS影子限价单缺少有效价格");
    params.price = Number(intent.price);
    params.timeInForce = intent.timeInForce || "GTC";
  }
  return {
    id: intent.clientOrderId,
    method: "order.place",
    params,
    priority: intent.reduceOnly ? "EMERGENCY" : "NORMAL",
  };
}

export function compareRestAndWsOrderSemantics(
  rest: Record<string, string | number | boolean>,
  ws: NexusWsUnsignedRequest,
) {
  const fields = [
    "symbol",
    "side",
    "positionSide",
    "type",
    "quantity",
    "price",
    "timeInForce",
    "newClientOrderId",
    "reduceOnly",
  ];
  const mismatches = fields.flatMap((field) => {
    const left = rest[field];
    const right = ws.params[field];
    if (left === undefined && right === undefined) return [];
    return String(left) === String(right)
      ? []
      : [{ field, rest: left ?? null, websocket: right ?? null }];
  });
  return { matches: mismatches.length === 0, mismatches };
}

export class NexusWsExecutionBuffer {
  private readonly emergency: NexusWsUnsignedRequest[] = [];
  private readonly normal: NexusWsUnsignedRequest[] = [];
  private readonly ids = new Set<string>();
  private readonly capacity: number;

  constructor(capacity = 256) {
    if (!Number.isInteger(capacity) || capacity < 1)
      throw new Error("WS执行缓冲容量无效");
    this.capacity = capacity;
  }

  enqueue(request: NexusWsUnsignedRequest) {
    if (this.ids.has(request.id))
      return { accepted: false, reason: "DUPLICATE" } as const;
    if (this.size >= this.capacity)
      return { accepted: false, reason: "BUFFER_FULL" } as const;
    this.ids.add(request.id);
    (request.priority === "EMERGENCY" ? this.emergency : this.normal).push(
      request,
    );
    return { accepted: true, reason: "BUFFERED" } as const;
  }

  flush(maxItems = this.capacity) {
    const output: NexusWsUnsignedRequest[] = [];
    while (output.length < maxItems && this.emergency.length)
      output.push(this.emergency.shift()!);
    while (output.length < maxItems && this.normal.length)
      output.push(this.normal.shift()!);
    for (const item of output) this.ids.delete(item.id);
    return output;
  }

  get size() {
    return this.emergency.length + this.normal.length;
  }
}
