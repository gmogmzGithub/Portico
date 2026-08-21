// Cost Dashboard component - Control Plane
// Tracks spend and usage across all chats using Electron main-process reporting.

let costDashboardInitialized = false;
let costDashboardLoaded = false;
let costDashboardLoading = false;
let costDashboardRefreshTimer = null;

const costDashboardState = {
  range: "4h",
  modelId: "all",
  pivot: "chat",
  data: null,
};

const COST_DASHBOARD_META_MODEL_FILTERS = [
  { value: "group:atlas", label: "All Atlas Models", family: "atlas" },
  { value: "group:gpt", label: "All GPT Models", family: "gpt" },
  { value: "group:gemini", label: "All Gemini Models", family: "gemini" },
];

let costDashboardFloatingTooltip = null;
let costDashboardInfoTooltip = null;

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatCurrency(value) {
  const amount = Number.isFinite(Number(value)) ? Number(value) : 0;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: amount >= 100 ? 0 : 2,
    maximumFractionDigits: amount >= 100 ? 0 : 2,
  }).format(amount);
}

function formatCompactCurrency(value) {
  const amount = Number.isFinite(Number(value)) ? Number(value) : 0;
  if (Math.abs(amount) < 1000) {
    return formatCurrency(amount);
  }
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(amount);
}

function formatInteger(value) {
  return new Intl.NumberFormat().format(
    Number.isFinite(Number(value)) ? Number(value) : 0,
  );
}

function formatPercent(value) {
  const amount = Number.isFinite(Number(value)) ? Number(value) : 0;
  return `${(amount * 100).toFixed(1)}%`;
}

function formatSignedCurrency(value) {
  const amount = Number.isFinite(Number(value)) ? Number(value) : 0;
  if (amount === 0) {
    return formatCurrency(0);
  }
  return `${amount > 0 ? "+" : "-"}${formatCurrency(Math.abs(amount))}`;
}

function getSavingsTone(value) {
  const amount = Number.isFinite(Number(value)) ? Number(value) : 0;
  if (amount > 0) return "positive";
  if (amount < 0) return "warning";
  return "default";
}

function sortCostDashboardModels(models) {
  return [...(Array.isArray(models) ? models : [])].sort((left, right) => {
    const leftLabel = String(left?.modelName || left?.modelId || "");
    const rightLabel = String(right?.modelName || right?.modelId || "");
    const byName = leftLabel.localeCompare(rightLabel, undefined, {
      numeric: true,
      sensitivity: "base",
    });
    if (byName !== 0) {
      return byName;
    }

    return String(left?.modelId || "").localeCompare(String(right?.modelId || ""), undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });
}

function getCostDashboardModelFamily(model) {
  const lookup = `${model?.modelName || ""} ${model?.modelId || ""}`.toLowerCase();
  if (lookup.includes("atlas")) {
    return "atlas";
  }
  if (lookup.includes("gpt")) {
    return "gpt";
  }
  if (lookup.includes("gemini") || lookup.includes("google")) {
    return "gemini";
  }
  return null;
}

function buildCostDashboardModelFilterOptions(availableModels, activeModelId) {
  const sortedModels = sortCostDashboardModels(availableModels);
  const availableFamilies = new Set(
    sortedModels.map((model) => getCostDashboardModelFamily(model)).filter(Boolean),
  );
  const metaOptions = COST_DASHBOARD_META_MODEL_FILTERS.filter((option) =>
    availableFamilies.has(option.family),
  );
  const optionLabelByValue = new Map([
    ["all", "All Models"],
    ...metaOptions.map((option) => [option.value, option.label]),
    ...sortedModels.map((model) => [model.modelId, model.modelName || model.modelId]),
  ]);

  const options = [
    `<option value="all"${activeModelId === "all" ? " selected" : ""}>All Models</option>`,
    ...metaOptions.map(
      (option) => `
        <option value="${escapeHtml(option.value)}"${activeModelId === option.value ? " selected" : ""}>
          ${escapeHtml(option.label)}
        </option>
      `,
    ),
  ];

  if (metaOptions.length > 0 && sortedModels.length > 0) {
    options.push(`<option value="" disabled>--------------------</option>`);
  }

  options.push(
    ...sortedModels.map(
      (model) => `
        <option value="${escapeHtml(model.modelId)}"${activeModelId === model.modelId ? " selected" : ""}>
          ${escapeHtml(model.modelName || model.modelId)}
        </option>
      `,
    ),
  );

  return {
    optionsMarkup: options.join(""),
    selectedLabel:
      optionLabelByValue.get(activeModelId) ||
      optionLabelByValue.get("all") ||
      "All Models",
  };
}

function getCostDashboardShell() {
  return document.getElementById("cost-dashboard-shell");
}

function getCostDashboardFloatingTooltip() {
  if (!costDashboardFloatingTooltip) {
    costDashboardFloatingTooltip = document.createElement("div");
    costDashboardFloatingTooltip.className = "cost-dashboard-chart-tooltip";
    costDashboardFloatingTooltip.hidden = true;
    document.body.appendChild(costDashboardFloatingTooltip);
  }

  return costDashboardFloatingTooltip;
}

function getCostDashboardInfoTooltip() {
  if (!costDashboardInfoTooltip) {
    costDashboardInfoTooltip = document.createElement("div");
    costDashboardInfoTooltip.className = "cost-dashboard-info-tooltip";
    costDashboardInfoTooltip.hidden = true;
    document.body.appendChild(costDashboardInfoTooltip);
  }

  return costDashboardInfoTooltip;
}

function getMagnifyIconMarkup(popoverText) {
  return `
    <button
      type="button"
      class="cost-dashboard-info-button"
      aria-label="${escapeHtml(popoverText)}"
      data-popover-text="${escapeHtml(popoverText)}"
    >
      <span class="cost-dashboard-info-icon" aria-hidden="true">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="8.5" cy="8.5" r="4.75"></circle>
          <path d="M12.2 12.2L16.25 16.25"></path>
        </svg>
      </span>
    </button>
  `;
}

function getRangeButtonsMarkup(activeRange) {
  const ranges = [
    { value: "1h", label: "1H" },
    { value: "4h", label: "4H" },
    { value: "1d", label: "1D" },
    { value: "7d", label: "7D" },
    { value: "30d", label: "30D" },
    { value: "90d", label: "90D" },
    { value: "all", label: "All" },
  ];

  return ranges
    .map(
      (item) => `
        <button
          class="cost-dashboard-range-btn${activeRange === item.value ? " active" : ""}"
          data-range="${item.value}"
          type="button"
        >
          ${escapeHtml(item.label)}
        </button>
      `,
    )
    .join("");
}

function getPivotButtonsMarkup(activePivot) {
  const pivots = [
    { value: "chat", label: "Chat" },
    { value: "time", label: "Time" },
  ];

  return pivots
    .map(
      (item) => `
        <button
          class="cost-dashboard-pivot-btn${activePivot === item.value ? " active" : ""}"
          data-pivot="${item.value}"
          type="button"
        >
          ${escapeHtml(item.label)}
        </button>
      `,
    )
    .join("");
}

function buildMetricCard(label, value, meta, options = {}) {
  const tone = options.tone || "default";
  const valueTone = options.valueTone || "default";
  const metaTone = options.metaTone || "default";
  const metaContent =
    typeof options.metaHtml === "string" ? options.metaHtml : escapeHtml(meta ?? "");

  return `
    <div class="cost-dashboard-metric tone-${escapeHtml(tone)}">
      <div class="cost-dashboard-metric-label">${escapeHtml(label)}</div>
      <div class="cost-dashboard-metric-value value-${escapeHtml(valueTone)}">${escapeHtml(value)}</div>
      <div class="cost-dashboard-metric-meta meta-${escapeHtml(metaTone)}">${metaContent}</div>
    </div>
  `;
}

function buildTrendChart(series, options = {}) {
  if (!Array.isArray(series) || series.length === 0) {
    return `
      <div class="cost-dashboard-chart-empty">
        No prompt completions yet for this range.
      </div>
    `;
  }

  const width = 760;
  const height = 248;
  const paddingTop = 18;
  const paddingBottom = 34;
  const paddingLeft = 58;
  const paddingRight = 14;
  const granularity = options.granularity === "hour" ? "hour" : "day";
  const chartHeight = height - paddingTop - paddingBottom;
  const chartWidth = width - paddingLeft - paddingRight;
  const step = series.length > 0 ? chartWidth / series.length : chartWidth;
  const maxStackTotal = Math.max(
    0.01,
    ...series.map((point) => {
      const cost = Math.max(0, Number(point.cost) || 0);
      const estimatedCostWithoutCache = Math.max(
        0,
        Number(point.estimatedCostWithoutCache) || 0,
      );
      const positiveSavings = Math.max(0, Number(point.netCacheSavings) || 0);

      return Math.max(cost, estimatedCostWithoutCache, cost + positiveSavings);
    }),
  );
  const yTickCount = 4;
  const yTicks = Array.from({ length: yTickCount + 1 }, (_, index) => {
    const ratio = index / yTickCount;
    const value = maxStackTotal * (1 - ratio);
    const y = paddingTop + chartHeight * ratio;
    return {
      value,
      y,
    };
  });

  const buildTopRoundedBarPath = (x, y, widthValue, heightValue, radius = 6) => {
    const safeX = Number.isFinite(Number(x)) ? Number(x) : 0;
    const safeY = Number.isFinite(Number(y)) ? Number(y) : 0;
    const safeWidth = Math.max(0, Number(widthValue) || 0);
    const safeHeight = Math.max(0, Number(heightValue) || 0);

    if (safeWidth === 0 || safeHeight === 0) {
      return "";
    }

    const cappedRadius = Math.min(radius, safeWidth / 2, safeHeight);
    const right = safeX + safeWidth;
    const bottom = safeY + safeHeight;

    if (cappedRadius <= 0) {
      return `M ${safeX} ${bottom} H ${right} V ${safeY} H ${safeX} Z`;
    }

    return [
      `M ${safeX} ${bottom}`,
      `V ${safeY + cappedRadius}`,
      `Q ${safeX} ${safeY} ${safeX + cappedRadius} ${safeY}`,
      `H ${right - cappedRadius}`,
      `Q ${right} ${safeY} ${right} ${safeY + cappedRadius}`,
      `V ${bottom}`,
      "Z",
    ].join(" ");
  };

  const bars = series
    .map((point, index) => {
      const cost = Math.max(0, Number(point.cost) || 0);
      const noCacheCost = Math.max(
        cost,
        Number(point.estimatedCostWithoutCache) || cost,
      );
      const netSavings = Number(point.netCacheSavings) || 0;
      const positiveSavings = Math.max(netSavings, 0);
      const modelCallCount = Number(point.responses) || 0;
      const inputTokens = Number(point.promptTokens) || 0;
      const outputTokens = Number(point.completionTokens) || 0;
      const cacheReadTokens = Number(point.cacheReadTokens) || 0;
      const cacheWriteTokens = Number(point.cacheWriteTokens) || 0;
      const savingsRate = noCacheCost > 0 ? netSavings / noCacheCost : 0;
      const costHeight =
        cost > 0 ? Math.max(2, (cost / maxStackTotal) * chartHeight) : 0;
      const savingsHeight =
        positiveSavings > 0
          ? Math.max(2, (positiveSavings / maxStackTotal) * chartHeight)
          : 0;
      const x = paddingLeft + index * step + step * 0.12;
      const stackBaseY = paddingTop + chartHeight;
      const costY = stackBaseY - costHeight;
      const savingsY = costY - savingsHeight;
      const widthValue = Math.max(4, step * 0.76);
      const savingsPath =
        savingsHeight > 0 && costHeight > 0
          ? buildTopRoundedBarPath(x, savingsY, widthValue, savingsHeight, 6)
          : "";
      const labelEvery =
        granularity === "hour"
          ? Math.max(1, Math.ceil(series.length / 8))
          : Math.max(1, Math.ceil(series.length / 6));
      const label =
        index % labelEvery === 0 || index === series.length - 1
          ? `<text x="${x + widthValue / 2}" y="${height - 10}" text-anchor="middle">${escapeHtml(point.label)}</text>`
          : "";
      const tooltipLabel = point.tooltipLabel || point.label;

      return `
        <g
          class="cost-dashboard-chart-bar"
          data-date="${escapeHtml(point.date)}"
          data-label="${escapeHtml(tooltipLabel)}"
          data-spend="${escapeHtml(String(cost))}"
          data-no-cache="${escapeHtml(String(noCacheCost))}"
          data-saved="${escapeHtml(String(netSavings))}"
          data-model-calls="${escapeHtml(String(modelCallCount))}"
          data-input-tokens="${escapeHtml(String(inputTokens))}"
          data-output-tokens="${escapeHtml(String(outputTokens))}"
          data-cache-read-tokens="${escapeHtml(String(cacheReadTokens))}"
          data-cache-write-tokens="${escapeHtml(String(cacheWriteTokens))}"
          data-savings-rate="${escapeHtml(String(savingsRate))}"
          data-model="${escapeHtml(point.modelName || "")}"
          data-chat-id="${escapeHtml(point.chatId || "")}"
          tabindex="0"
        >
          <rect
            class="cost-dashboard-chart-bar-net"
            x="${x.toFixed(2)}"
            y="${costY.toFixed(2)}"
            width="${widthValue.toFixed(2)}"
            height="${costHeight.toFixed(2)}"
            rx="${savingsHeight > 0 ? 0 : 6}"
          ></rect>
          ${
            savingsHeight > 0
              ? savingsPath
                ? `<path
                  class="cost-dashboard-chart-bar-savings"
                  d="${savingsPath}"
                ></path>`
                : `<rect
                  class="cost-dashboard-chart-bar-savings"
                  x="${x.toFixed(2)}"
                  y="${savingsY.toFixed(2)}"
                  width="${widthValue.toFixed(2)}"
                  height="${savingsHeight.toFixed(2)}"
                  rx="6"
                ></rect>`
              : ""
          }
          ${label}
        </g>
      `;
    })
    .join("");

  const pivot = options.pivot || "time";
  const range = options.range || "";
  const subtitle =
    pivot === "chat"
      ? "Spend and cache savings per chat"
      : range === "1h"
        ? "Hourly spend and cache savings across the last hour"
        : range === "4h"
          ? "Hourly spend and cache savings across the last 4 hours"
          : granularity === "hour"
            ? "Hourly spend and cache savings across the last 24 hours"
            : "Daily spend and cache savings across the selected range";

  const yAxisMarkup = yTicks
    .map(
      (tick) => `
        <g class="cost-dashboard-chart-tick">
          <line
            x1="${paddingLeft}"
            y1="${tick.y.toFixed(2)}"
            x2="${width - paddingRight}"
            y2="${tick.y.toFixed(2)}"
            class="cost-dashboard-chart-grid"
          ></line>
          <text
            x="${paddingLeft - 8}"
            y="${(tick.y + 4).toFixed(2)}"
            text-anchor="end"
            class="cost-dashboard-chart-axis-label"
          >${escapeHtml(formatCurrency(tick.value))}</text>
        </g>
      `,
    )
    .join("");

  return `
    <div class="cost-dashboard-chart-header">
      <div>
        <div class="cost-dashboard-panel-title">Spend Trend</div>
        <div class="cost-dashboard-panel-subtitle">${escapeHtml(subtitle)}</div>
      </div>
    </div>
    <div class="cost-dashboard-chart-stage" data-pivot="${escapeHtml(pivot)}">
      <svg class="cost-dashboard-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Spend trend">
        ${yAxisMarkup}
        <line x1="${paddingLeft}" y1="${paddingTop + chartHeight}" x2="${width - paddingRight}" y2="${paddingTop + chartHeight}" class="cost-dashboard-chart-axis"></line>
        ${bars}
      </svg>
    </div>
  `;
}

function buildModelCards(models) {
  if (!Array.isArray(models) || models.length === 0) {
    return `
      <div class="cost-dashboard-table-empty">
        No model activity in this slice yet.
      </div>
    `;
  }

  const cards = sortCostDashboardModels(models)
    .map((model) => {
      const savingsCardTone = getSavingsTone(model.netCacheSavings);
      const savingsValueTone = model.netCacheSavings >= 0 ? "savings" : "warning";

      return `
        <article class="cost-dashboard-model-card">
          <div class="cost-dashboard-model-card-header">
            <div class="cost-dashboard-model-name">${escapeHtml(model.modelName || model.modelId)}</div>
          </div>
          <div class="cost-dashboard-model-grid">
            <div class="cost-dashboard-model-stat tone-cost">
              <div class="cost-dashboard-model-stat-label">Net Cost</div>
              <div class="cost-dashboard-model-stat-value cost">${escapeHtml(formatCurrency(model.totalCost))}</div>
              <div class="cost-dashboard-model-stat-meta">${escapeHtml(`${formatInteger(model.responses)} model calls`)}</div>
            </div>
            <div class="cost-dashboard-model-stat tone-${escapeHtml(savingsCardTone)} has-popover">
              <div class="cost-dashboard-model-stat-label">Net Savings</div>
              <div class="cost-dashboard-model-stat-value ${escapeHtml(savingsValueTone)}">${escapeHtml(formatSignedCurrency(model.netCacheSavings))}</div>
              <div class="cost-dashboard-model-stat-meta ${escapeHtml(savingsValueTone)}">
                ${escapeHtml(`${formatPercent(model.savingsRate)} savings`)}
                ${getMagnifyIconMarkup(`Raw cost before savings: ${formatCurrency(model.estimatedCostWithoutCache)}`)}
              </div>
            </div>
            <div class="cost-dashboard-model-stat">
              <div class="cost-dashboard-model-stat-label">Input Tokens</div>
              <div class="cost-dashboard-model-stat-value">${escapeHtml(formatInteger(model.promptTokens))}</div>
            </div>
            <div class="cost-dashboard-model-stat">
              <div class="cost-dashboard-model-stat-label">Output Tokens</div>
              <div class="cost-dashboard-model-stat-value">${escapeHtml(formatInteger(model.completionTokens))}</div>
            </div>
            <div class="cost-dashboard-model-stat span-2 tone-cache">
              <div class="cost-dashboard-model-stat-label">Cache Activity</div>
              <div class="cost-dashboard-model-stat-value">${escapeHtml(`${formatInteger(model.cacheReadTokens)} read`)}</div>
              <div class="cost-dashboard-model-stat-meta">${escapeHtml(`${formatInteger(model.cacheWriteTokens)} write`)}</div>
            </div>
          </div>
        </article>
      `;
    })
    .join("");

  return `
    <div class="cost-dashboard-model-cards">
      ${cards}
    </div>
  `;
}

function bindCostDashboardChartTooltips(shell) {
  const tooltip = getCostDashboardFloatingTooltip();

  const hideTooltip = () => {
    tooltip.hidden = true;
    tooltip.innerHTML = "";
  };

  shell.querySelectorAll(".cost-dashboard-chart-stage").forEach((stage) => {
    const showTooltip = (bar, event) => {
      const label = bar.dataset.label || bar.dataset.date || "";
      const spend = Number(bar.dataset.spend || 0);
      const noCache = Number(bar.dataset.noCache || 0);
      const saved = Number(bar.dataset.saved || 0);
      const modelCalls = Number(bar.dataset.modelCalls || 0);
      const inputTokens = Number(bar.dataset.inputTokens || 0);
      const outputTokens = Number(bar.dataset.outputTokens || 0);
      const cacheReadTokens = Number(bar.dataset.cacheReadTokens || 0);
      const cacheWriteTokens = Number(bar.dataset.cacheWriteTokens || 0);
      const savingsRate = Number(bar.dataset.savingsRate || 0);
      const modelName = bar.dataset.model || "";

      const modelRow = modelName
        ? `<div class="cost-dashboard-chart-tooltip-row">
            <span>Model</span>
            <strong>${escapeHtml(modelName)}</strong>
          </div>`
        : "";

      tooltip.innerHTML = `
        <div class="cost-dashboard-chart-tooltip-title">${escapeHtml(label)}</div>
        ${modelRow}
        <div class="cost-dashboard-chart-tooltip-row">
          <span>Net Cost</span>
          <strong class="cost">${escapeHtml(formatCurrency(spend))}</strong>
        </div>
        <div class="cost-dashboard-chart-tooltip-meta">${escapeHtml(`${formatInteger(modelCalls)} model calls`)}</div>
        <div class="cost-dashboard-chart-tooltip-row">
          <span>Net Savings</span>
          <strong class="${saved >= 0 ? "savings" : "warning"}">${escapeHtml(formatSignedCurrency(saved))}</strong>
        </div>
        <div class="cost-dashboard-chart-tooltip-meta">${escapeHtml(`${formatPercent(savingsRate)} savings, raw cost ${formatCurrency(noCache)}`)}</div>
        <div class="cost-dashboard-chart-tooltip-row">
          <span>Input Tokens</span>
          <strong>${escapeHtml(formatInteger(inputTokens))}</strong>
        </div>
        <div class="cost-dashboard-chart-tooltip-row">
          <span>Output Tokens</span>
          <strong>${escapeHtml(formatInteger(outputTokens))}</strong>
        </div>
        <div class="cost-dashboard-chart-tooltip-row">
          <span>Cache Activity</span>
          <strong>${escapeHtml(`${formatInteger(cacheReadTokens)} read / ${formatInteger(cacheWriteTokens)} write`)}</strong>
        </div>
      `;
      tooltip.hidden = false;
      tooltip.style.left = `${event.clientX}px`;
      tooltip.style.top = `${Math.max(16, event.clientY - 14)}px`;

      const tooltipRect = tooltip.getBoundingClientRect();
      const padding = 16;
      let left = event.clientX;
      let top = Math.max(padding + tooltipRect.height, event.clientY - 14);

      if (left + tooltipRect.width / 2 > window.innerWidth - padding) {
        left = window.innerWidth - padding - tooltipRect.width / 2;
      }
      if (left - tooltipRect.width / 2 < padding) {
        left = padding + tooltipRect.width / 2;
      }
      if (top - tooltipRect.height < padding) {
        top = padding + tooltipRect.height;
      }

      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${top}px`;
    };

    const isChatPivot = stage.dataset.pivot === "chat";

    stage.querySelectorAll(".cost-dashboard-chart-bar").forEach((bar) => {
      bar.addEventListener("mouseenter", (event) => showTooltip(bar, event));
      bar.addEventListener("mousemove", (event) => showTooltip(bar, event));
      bar.addEventListener("mouseleave", hideTooltip);
      if (isChatPivot) {
        bar.addEventListener("click", async () => {
          const chatId = bar.dataset.chatId;
          if (!chatId) {
            return;
          }
          const url = `http://localhost:3789/c/${chatId}`;

          // Open tab-first so a chat (esp. a subagent chat) never ends up in both
          // a tab AND a window. Decision mirrors resolveCostBarChatOpenPlan
          // (src/services/cost-dashboard-open-logic.js):
          //   already a window -> focus it; tab slot free/existing -> tab;
          //   all slots taken  -> new window.
          let isWindowOpen = false;
          try {
            isWindowOpen =
              (await window.electronAPI?.focusConversationWindowIfOpen?.(chatId)) === true;
          } catch (error) {
            console.warn("[CostDashboard] window focus check failed:", error);
          }
          if (isWindowOpen) {
            return; // already focused the existing window
          }

          const canOpenTab =
            typeof window.canOpenAdditionalConversationTab === "function"
              ? window.canOpenAdditionalConversationTab(chatId)
              : typeof window.openConversationTab === "function";

          if (canOpenTab && typeof window.openConversationTab === "function") {
            window.openConversationTab(url, chatId, { title: "Chat", type: "chat" });
            return;
          }

          // All tab slots are taken -> open a new window.
          window.electronAPI?.detachConversation?.(chatId, url, "Chat", "chat");
        });
      }
      bar.addEventListener("focus", () => {
        const rect = bar.getBoundingClientRect();
        showTooltip(bar, {
          clientX: rect.left + rect.width / 2,
          clientY: rect.top,
        });
      });
      bar.addEventListener("blur", hideTooltip);
    });
  });
}

function bindCostDashboardInfoTooltips(shell) {
  const tooltip = getCostDashboardInfoTooltip();

  const hideTooltip = () => {
    tooltip.hidden = true;
    tooltip.textContent = "";
  };

  const showTooltip = (button) => {
    const text = button.dataset.popoverText || "";
    if (!text) {
      hideTooltip();
      return;
    }

    tooltip.textContent = text;
    tooltip.hidden = false;

    const buttonRect = button.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const padding = 16;
    const gap = 10;
    let left = buttonRect.left + buttonRect.width / 2 - tooltipRect.width / 2;
    let top = buttonRect.top - tooltipRect.height - gap;

    if (left < padding) {
      left = padding;
    }
    if (left + tooltipRect.width > window.innerWidth - padding) {
      left = window.innerWidth - padding - tooltipRect.width;
    }
    if (top < padding) {
      top = buttonRect.bottom + gap;
    }
    if (top + tooltipRect.height > window.innerHeight - padding) {
      top = Math.max(padding, window.innerHeight - padding - tooltipRect.height);
    }

    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  };

  shell.querySelectorAll(".cost-dashboard-info-button").forEach((button) => {
    button.addEventListener("mouseenter", () => showTooltip(button));
    button.addEventListener("mousemove", () => showTooltip(button));
    button.addEventListener("mouseleave", hideTooltip);
    button.addEventListener("focus", () => showTooltip(button));
    button.addEventListener("blur", hideTooltip);
  });
}

function renderCostDashboard() {
  const shell = getCostDashboardShell();
  if (!shell) return;

  const data = costDashboardState.data;
  if (!data) {
    shell.innerHTML = `
      <div class="cost-dashboard-empty">
        <div class="cost-dashboard-empty-title">No cost data yet</div>
        <div class="cost-dashboard-empty-copy">
          Spend will appear here once prompts complete and report usage back to Electron.
        </div>
      </div>
    `;
    return;
  }

  const summary = data.filtered?.summary || {};
  const models = data.filtered?.models || [];
  const series = data.filtered?.series?.trend || [];
  const rawGranularity = data.filtered?.series?.granularity || data.filters?.granularity || "day";
  const activePivot = data.filters?.pivot || costDashboardState.pivot || "time";
  const seriesGranularity = activePivot === "chat" ? "day" : rawGranularity;
  const availableModels = Array.isArray(data.availableModels) ? data.availableModels : [];
  const modelFilterOptions = buildCostDashboardModelFilterOptions(
    availableModels,
    costDashboardState.modelId,
  );
  const selectedModelLabel = modelFilterOptions.selectedLabel;
  const modelSelectWidthCh = Math.min(Math.max(selectedModelLabel.length + 6, 18), 30);
  const modelOptions = modelFilterOptions.optionsMarkup;

  const metricCards = [
    buildMetricCard(
      "Net Cost",
      formatCurrency(summary.totalCost),
      `${formatInteger(summary.responses)} model calls`,
      { tone: "cost", valueTone: "cost" },
    ),
    buildMetricCard(
      "Net Savings",
      formatSignedCurrency(summary.netCacheSavings),
      "",
      {
        tone: getSavingsTone(summary.netCacheSavings),
        valueTone: summary.netCacheSavings >= 0 ? "savings" : "warning",
        metaTone: summary.netCacheSavings >= 0 ? "savings" : "warning",
        metaHtml: `
          <span>${escapeHtml(`${formatPercent(summary.savingsRate)} savings`)}</span>
          ${getMagnifyIconMarkup(`Raw cost before savings: ${formatCurrency(summary.estimatedCostWithoutCache)}`)}
        `,
      },
    ),
    buildMetricCard(
      "Input Tokens",
      formatInteger(summary.promptTokens),
      "Prompt tokens",
      { tone: "default", valueTone: "default" },
    ),
    buildMetricCard(
      "Output Tokens",
      formatInteger(summary.completionTokens),
      "Completion tokens",
      { tone: "default", valueTone: "default" },
    ),
    buildMetricCard(
      "Cache Activity",
      `${formatInteger(summary.cacheReadTokens)} read`,
      `${formatInteger(summary.cacheWriteTokens)} write`,
      { tone: "default", valueTone: "default" },
    ),
  ].join("");

  shell.innerHTML = `
    <div class="cost-dashboard-toolbar">
      <div class="cost-dashboard-toolbar-group">
        <div class="cost-dashboard-toolbar-label">Range</div>
        <div class="cost-dashboard-range-group">
          ${getRangeButtonsMarkup(costDashboardState.range)}
        </div>
      </div>
      <div class="cost-dashboard-toolbar-group">
        <div class="cost-dashboard-toolbar-label">View</div>
        <div class="cost-dashboard-range-group">
          ${getPivotButtonsMarkup(costDashboardState.pivot)}
        </div>
      </div>
      <div class="cost-dashboard-toolbar-group">
        <label class="cost-dashboard-toolbar-label" for="cost-dashboard-model-filter">Model</label>
        <select class="cost-dashboard-model-select" id="cost-dashboard-model-filter" style="width: min(100%, ${modelSelectWidthCh}ch)">
          ${modelOptions}
        </select>
      </div>
    </div>

    <div class="cost-dashboard-metrics-grid">
      ${metricCards}
    </div>

    <div class="cost-dashboard-stack">
      <section class="cost-dashboard-panel cost-dashboard-trend-panel">
        ${buildTrendChart(series, { granularity: seriesGranularity, pivot: activePivot, range: costDashboardState.range })}
      </section>

      <section class="cost-dashboard-breakdown-panel">
        <div class="cost-dashboard-panel-header">
          <div class="cost-dashboard-panel-title">Model Breakdown</div>
        </div>
        ${buildModelCards(models)}
      </section>
    </div>
  `;

  bindCostDashboardChartTooltips(shell);
  bindCostDashboardInfoTooltips(shell);
}

async function loadCostDashboard(force = false) {
  const shell = getCostDashboardShell();
  if (!shell || !window.electronAPI?.getCostDashboard) {
    return;
  }

  if (costDashboardLoading && !force) {
    return;
  }

  costDashboardLoading = true;

  try {
    const result = await window.electronAPI.getCostDashboard({
      range: costDashboardState.range,
      modelId: costDashboardState.modelId,
      pivot: costDashboardState.pivot,
    });

    if (!result?.success) {
      throw new Error(result?.error || "Failed to load cost dashboard");
    }

    costDashboardState.data = result.data;
    costDashboardLoaded = true;
    renderCostDashboard();
  } catch (error) {
    shell.innerHTML = `
      <div class="cost-dashboard-empty">
        <div class="cost-dashboard-empty-title">Failed to load cost dashboard</div>
        <div class="cost-dashboard-empty-copy">${escapeHtml(error.message || String(error))}</div>
      </div>
    `;
  } finally {
    costDashboardLoading = false;
  }
}

function setCostDashboardVisible(isVisible) {
  const view = document.getElementById("cost-dashboard-view");
  const actions = document.getElementById("cost-dashboard-header-actions");

  if (view) {
    view.style.display = isVisible ? "" : "none";
  }
  if (actions) {
    actions.style.display = isVisible ? "" : "none";
  }
}

function showCostDashboard() {
  const costDashboardBtn = document.getElementById("view-cost-dashboard-btn");
  const mcpServersBtn = document.getElementById("view-mcp-servers-btn");
  const agentSkillsBtn = document.getElementById("view-agent-skills-btn");
  const agentsTabBtn = document.getElementById("view-agents-tab-btn");
  const mcpServersView = document.getElementById("mcp-servers-view");
  const agentSkillsView = document.getElementById("agent-skills-view");
  const agentsTabView = document.getElementById("agents-tab-view");
  const mcpHeaderActions = document.getElementById("mcp-header-actions");
  const skillsHeaderActions = document.getElementById("skills-header-actions");
  const agentsTabHeaderActions = document.getElementById("agents-tab-header-actions");

  costDashboardBtn?.classList.add("active");
  mcpServersBtn?.classList.remove("active");
  agentSkillsBtn?.classList.remove("active");
  agentsTabBtn?.classList.remove("active");

  if (mcpServersView) mcpServersView.style.display = "none";
  if (agentSkillsView) agentSkillsView.style.display = "none";
  if (agentsTabView) agentsTabView.style.display = "none";
  setCostDashboardVisible(true);

  if (mcpHeaderActions) mcpHeaderActions.style.display = "none";
  if (skillsHeaderActions) skillsHeaderActions.style.display = "none";
  if (agentsTabHeaderActions) agentsTabHeaderActions.style.display = "none";

  if (window.appState) {
    window.appState.controlPlaneView = "cost-dashboard";
  }

  void loadCostDashboard();
}

function handleCostDashboardFilters(event) {
  const rangeButton = event.target.closest(".cost-dashboard-range-btn");
  if (rangeButton?.dataset?.range) {
    const nextRange = rangeButton.dataset.range;
    if (nextRange && nextRange !== costDashboardState.range) {
      costDashboardState.range = nextRange;
      void loadCostDashboard(true);
    }
  }

  const pivotButton = event.target.closest(".cost-dashboard-pivot-btn");
  if (pivotButton?.dataset?.pivot) {
    const nextPivot = pivotButton.dataset.pivot;
    if (nextPivot && nextPivot !== costDashboardState.pivot) {
      costDashboardState.pivot = nextPivot;
      void loadCostDashboard(true);
    }
  }
}

function handleCostDashboardModelChange(event) {
  const target = event.target;
  if (target?.id !== "cost-dashboard-model-filter") {
    return;
  }

  const nextModelId = target.value || "all";
  if (nextModelId !== costDashboardState.modelId) {
    costDashboardState.modelId = nextModelId;
    void loadCostDashboard(true);
  }
}

function queueCostDashboardRefresh() {
  if (costDashboardRefreshTimer) {
    clearTimeout(costDashboardRefreshTimer);
  }

  costDashboardRefreshTimer = setTimeout(() => {
    costDashboardRefreshTimer = null;
    if (costDashboardLoaded) {
      void loadCostDashboard(true);
    }
  }, 250);
}

function initCostDashboard() {
  if (costDashboardInitialized) {
    return;
  }
  costDashboardInitialized = true;

  const shell = getCostDashboardShell();
  const costDashboardBtn = document.getElementById("view-cost-dashboard-btn");
  const refreshBtn = document.getElementById("refresh-cost-dashboard-btn");
  const openFolderBtn = document.getElementById("open-cost-reporting-folder-btn");
  const mcpServersBtn = document.getElementById("view-mcp-servers-btn");
  const agentSkillsBtn = document.getElementById("view-agent-skills-btn");
  const agentsTabBtn = document.getElementById("view-agents-tab-btn");

  if (!shell || !costDashboardBtn) {
    return;
  }

  costDashboardBtn.addEventListener("click", showCostDashboard);
  mcpServersBtn?.addEventListener("click", () => setCostDashboardVisible(false));
  agentSkillsBtn?.addEventListener("click", () => setCostDashboardVisible(false));
  agentsTabBtn?.addEventListener("click", () => setCostDashboardVisible(false));

  shell.addEventListener("click", handleCostDashboardFilters);
  shell.addEventListener("change", handleCostDashboardModelChange);

  refreshBtn?.addEventListener("click", () => {
    void loadCostDashboard(true);
  });

  openFolderBtn?.addEventListener("click", async () => {
    try {
      const result = await window.electronAPI?.revealCostReportingFolder?.();
      if (!result?.success) {
        throw new Error(result?.error || "Failed to open reporting folder");
      }
    } catch (error) {
      window.showNotification?.(error.message || String(error), "error");
    }
  });

  window.electronAPI?.onCostReportUpdated?.(() => {
    queueCostDashboardRefresh();
  });
}

window.initCostDashboard = initCostDashboard;
window.refreshCostDashboard = () => loadCostDashboard(true);

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initCostDashboard);
} else {
  initCostDashboard();
}
