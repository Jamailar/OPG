interface IconProps {
  className?: string;
  size?: number;
  variant?: 'default' | 'white';
}

export function AppBrandMark({ className, size = 44, variant = 'default' }: IconProps) {
  const classes = className ? `app-brand-mark ${className}` : 'app-brand-mark';
  const src = variant === 'white' ? '/opg-logo-white.png' : '/opg-logo.png';

  return (
    <img
      alt=""
      aria-hidden="true"
      className={classes}
      draggable={false}
      height={size}
      src={src}
      style={{ objectFit: 'contain' }}
      width={size}
    />
  );
}

export function MenuIcon({ className, size = 18 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      focusable="false"
      height={size}
      viewBox="0 0 24 24"
      width={size}
    >
      <path
        d="M4 7H20M4 12H20M4 17H20"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2.4"
      />
    </svg>
  );
}

interface SidebarToggleIconProps extends IconProps {
  collapsed?: boolean;
}

export function SidebarToggleIcon({
  className,
  collapsed = false,
  size = 18,
}: SidebarToggleIconProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      focusable="false"
      height={size}
      viewBox="0 0 24 24"
      width={size}
    >
      <rect
        fill="currentColor"
        height="14"
        opacity="0.18"
        rx="1.4"
        width="4"
        x="4"
        y="5"
      />
      <rect
        fill="currentColor"
        height="14"
        opacity="0.08"
        rx="1.4"
        width="10"
        x="10"
        y="5"
      />
      {collapsed ? (
        <path
          d="M11 12H17M15 9L18 12L15 15"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
        />
      ) : (
        <path
          d="M17 12H11M13 9L10 12L13 15"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
        />
      )}
    </svg>
  );
}
