import React from 'react';

export const LogoTextComponent = () => {
  return (
    <div
      className="flex items-center gap-[10px]"
      aria-label="AgencyOS by NextGen OS"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="32"
        height="32"
        viewBox="0 0 60 60"
        fill="none"
        aria-hidden="true"
      >
        <rect x="4" y="4" width="52" height="52" rx="14" fill="#6D4AFF" />
        <path
          d="M18 43L30 16L42 43M23 34H37"
          stroke="white"
          strokeWidth="5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <div className="flex flex-col leading-[1.1]">
        <span className="text-[22px] font-semibold tracking-tight">
          AgencyOS
        </span>
        <span className="text-[11px] opacity-60">by NextGen OS</span>
      </div>
    </div>
  );
};
