import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

type ChartDatum = {
  label: string;
  [key: string]: string | number | null | undefined;
};

type ChartSeries = {
  key: string;
  label: string;
  color: string;
  formatter?: (value: number) => string;
  tickFormatter?: (value: number) => string;
  strokeWidth?: number;
  yAxisId?: string;
  axis?: 'left' | 'right';
};

type Props = {
  data: ChartDatum[];
  series: ChartSeries[];
  emptyText: string;
  height?: number;
  className?: string;
  tooltipExtras?: (datum: ChartDatum) => Array<{ label: string; value: string }>;
};

type TooltipProps = {
  active?: boolean;
  payload?: Array<{ dataKey?: string; value?: number; color?: string }>;
  label?: string;
};

function formatCount(value: number) {
  return new Intl.NumberFormat('zh-CN').format(Number(value || 0));
}

function DefaultTooltip({
  active,
  payload,
  label,
  series,
  data,
  tooltipExtras,
}: TooltipProps & {
  series: ChartSeries[];
  data: ChartDatum[];
  tooltipExtras?: (datum: ChartDatum) => Array<{ label: string; value: string }>;
}) {
  if (!active || !payload?.length || !label) return null;
  const datum = data.find((item) => item.label === label);
  return (
    <div className="trend-multi-line-tooltip">
      <div className="trend-multi-line-tooltip-title">{label}</div>
      {series.map((item) => {
        const payloadItem = payload.find((entry) => entry.dataKey === item.key);
        const rawValue = Number(payloadItem?.value || 0);
        const formatter = item.formatter || formatCount;
        return (
          <div key={item.key} className="trend-multi-line-tooltip-row">
            <span className="trend-multi-line-tooltip-dot" style={{ background: item.color }} />
            <span>{item.label}</span>
            <strong>{formatter(rawValue)}</strong>
          </div>
        );
      })}
      {(datum && tooltipExtras ? tooltipExtras(datum) : []).map((item) => (
        <div key={item.label} className="trend-multi-line-tooltip-extra">
          <span>{item.label}</span>
          <strong>{item.value}</strong>
        </div>
      ))}
    </div>
  );
}

export default function TrendMultiLineChart({
  data,
  series,
  emptyText,
  height = 280,
  className = '',
  tooltipExtras,
}: Props) {
  if (!data.length || !series.length) {
    return <div className="analytics-empty-note">{emptyText}</div>;
  }

  const axisMap = series.reduce<
    Map<
      string,
      {
        id: string;
        orientation: 'left' | 'right';
        tickFormatter: (value: number) => string;
        color: string;
      }
    >
  >((acc, item) => {
    const axisId = item.yAxisId || item.axis || 'left';
    if (!acc.has(axisId)) {
      acc.set(axisId, {
        id: axisId,
        orientation: item.axis || (axisId === 'right' ? 'right' : 'left'),
        tickFormatter: item.tickFormatter || item.formatter || formatCount,
        color: item.color,
      });
    }
    return acc;
  }, new Map());

  const axes = Array.from(axisMap.values());
  const hasRightAxis = axes.some((axis) => axis.orientation === 'right');

  return (
    <div className={`trend-multi-line-chart-shell ${className}`.trim()}>
      <div className="trend-multi-line-chart-legend">
        {series.map((item) => {
          const formatter = item.formatter || formatCount;
          const lastValue = Number(data[data.length - 1]?.[item.key] || 0);
          return (
            <div key={item.key} className="trend-multi-line-legend-item">
              <span className="trend-multi-line-legend-dot" style={{ background: item.color }} />
              <span>{item.label}</span>
              <strong>{formatter(lastValue)}</strong>
            </div>
          );
        })}
      </div>
      <div className="trend-multi-line-chart-frame" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: hasRightAxis ? 12 : 8, left: 0, bottom: 8 }}>
            <CartesianGrid stroke="rgba(120, 98, 84, 0.16)" strokeDasharray="4 6" />
            <XAxis dataKey="label" tick={{ fill: '#876b5d', fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={24} />
            {axes.map((axis) => (
              <YAxis
                key={axis.id}
                yAxisId={axis.id}
                orientation={axis.orientation}
                tick={{ fill: axis.color, fontSize: 11 }}
                tickFormatter={axis.tickFormatter}
                axisLine={false}
                tickLine={false}
                width={56}
                allowDecimals={false}
              />
            ))}
            <Tooltip
              content={<DefaultTooltip series={series} data={data} tooltipExtras={tooltipExtras} />}
              cursor={{ stroke: 'rgba(37, 99, 235, 0.18)', strokeWidth: 1 }}
            />
            <Legend content={() => null} />
            {series.map((item) => (
              <Line
                key={item.key}
                type="monotone"
                dataKey={item.key}
                yAxisId={item.yAxisId || item.axis || 'left'}
                name={item.label}
                stroke={item.color}
                strokeWidth={item.strokeWidth ?? 3}
                dot={false}
                activeDot={{ r: 5, stroke: item.color, strokeWidth: 1, fill: '#fff' }}
                connectNulls
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
