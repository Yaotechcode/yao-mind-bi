/**
 * DonutChart — Pie/donut chart with optional center label and legend.
 */

import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';

export interface DonutDatum {
  name: string;
  value: number;
  colour: string;
}

export interface DonutChartProps {
  data: DonutDatum[];
  centerLabel?: { value: string; label: string };
}

function currencyFmt(v: number) {
  return `£${v.toLocaleString('en-GB', { maximumFractionDigits: 0 })}`;
}

export function DonutChart({ data, centerLabel }: DonutChartProps) {
  return (
    <div className="relative">
      <ResponsiveContainer width="100%" height={260}>
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            cx="50%"
            cy="50%"
            innerRadius={60}
            outerRadius={90}
            paddingAngle={2}
            strokeWidth={0}
          >
            {data.map((d, i) => (
              <Cell key={i} fill={d.colour} />
            ))}
          </Pie>
          <Tooltip
            formatter={(value: unknown) => [currencyFmt(Number(value)), '']}
            contentStyle={{ fontSize: 12, borderRadius: 6, border: '1px solid hsl(223 25% 93%)' }}
          />
          <Legend
            layout="vertical"
            align="right"
            verticalAlign="middle"
            wrapperStyle={{ fontSize: 11 }}
          />
        </PieChart>
      </ResponsiveContainer>
      {centerLabel && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none" style={{ paddingRight: 80 }}>
          <div className="text-center">
            <p className="text-lg font-bold text-foreground leading-tight">{centerLabel.value}</p>
            <p className="text-[10px] text-muted-foreground">{centerLabel.label}</p>
          </div>
        </div>
      )}
    </div>
  );
}
