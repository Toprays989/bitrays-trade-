import type { StoredStrategyParameterSuggestion } from "../client/strategy-view";

export function MovingProtectionReviewCard({
  suggestion,
}: {
  suggestion?: StoredStrategyParameterSuggestion;
}) {
  if (!suggestion) return null;
  const review = record(suggestion.currentValue);
  const candidate = record(review.candidate);
  const status = String(review.status ?? "COLLECTING");
  const statusLabel = {
    COLLECTING: "样本积累中",
    PRELIMINARY_REVIEW: "初步观察",
    KEEP_CURRENT: "保持当前参数",
    SHADOW_CANDIDATE: "存在影子候选",
  }[status] ?? "样本积累中";
  const candidateLabel = candidate.parameterName ===
      "risk.trailingActivationPercent"
    ? "启动ROE"
    : candidate.parameterName === "risk.trailingDrawdownPercent"
      ? "回撤ROE"
      : null;

  return (
    <section className="moving-protection-review">
      <div className="moving-protection-review-head">
        <div>
          <h3>移动保护参数评估</h3>
          <p>仅比较精确净结算、系统自动退出的完整周期；不改变实盘参数。</p>
        </div>
        <span className={`moving-review-status ${status.toLowerCase()}`}>
          {statusLabel}
        </span>
      </div>
      <div className="moving-protection-current">
        <span>
          当前启动 <b>{percent(review.currentActivationRoePercent)}</b>
        </span>
        <span>
          当前回撤 <b>{percent(review.currentDrawdownRoePoints)}</b>
        </span>
        <span>
          首档止盈 <b>{percent(review.firstTakeProfitRoePercent)}</b>
        </span>
        <span>
          可比周期 <b>{integer(review.automatedComparableSamples)}</b>
          /{integer(review.minimumCandidateSamples)}
        </span>
      </div>
      <div className="moving-protection-metrics">
        <article>
          <span>利润捕获中位数</span>
          <b>{percent(review.medianCaptureEfficiencyPercent)}</b>
          <small>最终净ROE ÷ 期间最高有利ROE</small>
        </article>
        <article>
          <span>盈利转亏</span>
          <b>{integer(review.givebackCount)} 笔</b>
          <small>{percent(review.givebackRatePercent)} 的有效波段</small>
        </article>
        <article>
          <span>启动前回吐</span>
          <b>{percent(review.preActivationGivebackRatePercent)}</b>
          <small>近期留出 {percent(review.recentPreActivationGivebackRatePercent)}</small>
        </article>
        <article>
          <span>启动后弱捕获</span>
          <b>{percent(review.postActivationWeakCaptureRatePercent)}</b>
          <small>近期留出 {percent(review.recentPostActivationWeakCaptureRatePercent)}</small>
        </article>
      </div>
      {candidateLabel ? (
        <div className="moving-protection-candidate">
          <div>
            <b>{candidateLabel}影子候选</b>
            <span>
              {percent(candidate.currentValue)} → {percent(candidate.candidateValue)}
            </span>
          </div>
          <p>只记录后续对照结果；不会自动带入草稿、保存策略或影响订单。</p>
        </div>
      ) : (
        <div className="moving-protection-candidate quiet">
          {status === "KEEP_CURRENT"
            ? "较早样本与近期留出样本未同时证明需要调整，当前参数保持不变。"
            : `尚未达到 ${integer(review.minimumCandidateSamples)} 个可比完整周期，不产生参数候选。`}
        </div>
      )}
      <p className="moving-protection-summary">
        {String(review.summary ?? suggestion.evidence.reason ?? "继续积累完整周期。")}
      </p>
    </section>
  );
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function number(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function percent(value: unknown) {
  const parsed = number(value);
  return parsed === null ? "—" : `${parsed.toFixed(1)}%`;
}

function integer(value: unknown) {
  const parsed = number(value);
  return parsed === null ? "0" : String(Math.max(0, Math.round(parsed)));
}
