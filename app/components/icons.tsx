type P = { className?: string };
const base = (className?: string) => ({
  className: className ?? "size-5",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
});

export const MicIcon = ({ className }: P) => (
  <svg {...base(className)}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </svg>
);

export const MicOffIcon = ({ className }: P) => (
  <svg {...base(className)}>
    <path d="M15 9.3V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 5.1 2.1M5 11a7 7 0 0 0 11.5 5.4M19 11a7 7 0 0 1-.6 2.8M12 18v3M3 3l18 18" />
  </svg>
);

export const ScreenIcon = ({ className }: P) => (
  <svg {...base(className)}>
    <rect x="2" y="4" width="20" height="13" rx="2" />
    <path d="M8 21h8M12 17v4" />
  </svg>
);

export const PhoneOffIcon = ({ className }: P) => (
  <svg {...base(className)}>
    <path d="M4.5 14.5c-1-1-1-2.6 0-3.6C9 6.4 15 6.4 19.5 10.9c1 1 1 2.6 0 3.6l-1.3 1.3a1 1 0 0 1-1.3.1l-2.3-1.6a1 1 0 0 1-.4-.9l.2-1.9a9 9 0 0 0-4.8 0l.2 1.9a1 1 0 0 1-.4.9l-2.3 1.6a1 1 0 0 1-1.3-.1z" />
  </svg>
);

export const LinkIcon = ({ className }: P) => (
  <svg {...base(className)}>
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
  </svg>
);

export const UsersIcon = ({ className }: P) => (
  <svg {...base(className)}>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5" />
  </svg>
);

export const VolumeIcon = ({ className }: P) => (
  <svg {...base(className)}>
    <path d="M11 5 6 9H3v6h3l5 4zM15.5 8.5a5 5 0 0 1 0 7" />
  </svg>
);

export const TrashIcon = ({ className }: P) => (
  <svg {...base(className)}>
    <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
  </svg>
);

export const ChartIcon = ({ className }: P) => (
  <svg {...base(className)}>
    <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
  </svg>
);
