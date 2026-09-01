interface StatCardProps {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  change?: string;
  changeType?: 'positive' | 'negative' | 'neutral';
  color?: 'primary' | 'blue' | 'purple' | 'yellow' | 'red' | 'green';
}

const colorMap = {
  primary: 'bg-primary-50 text-primary-600',
  blue: 'bg-blue-50 text-blue-600',
  purple: 'bg-purple-50 text-purple-600',
  yellow: 'bg-yellow-50 text-yellow-600',
  red: 'bg-red-50 text-red-600',
  green: 'bg-green-50 text-green-600',
};

export function StatCard({ icon, label, value, change, changeType, color = 'primary' }: StatCardProps) {
  return (
    <div className="stat-card">
      <div className="flex items-center gap-3">
        <div className={`p-2.5 rounded-xl ${colorMap[color]}`}>
          {icon}
        </div>
        <span className="stat-label">{label}</span>
      </div>
      <div className="stat-value">{value}</div>
      {change && (
        <span className={`stat-change ${
          changeType === 'positive' ? 'text-green-600' :
          changeType === 'negative' ? 'text-red-600' : 'text-gray-500'
        }`}>
          {change}
        </span>
      )}
    </div>
  );
}
