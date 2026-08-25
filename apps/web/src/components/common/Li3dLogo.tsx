import { useId, type SVGProps } from 'react';

type Li3dLogoProps = SVGProps<SVGSVGElement> & {
  title?: string;
};

export function Li3dLogo({ title = 'Li3D', ...props }: Li3dLogoProps) {
  const filterId = `li3d-remove-black-${useId().replace(/:/g, '')}`;

  return (
    <svg viewBox="0 0 1254 1254" role="img" aria-label={title} {...props}>
      <title>{title}</title>
      <defs>
        <filter id={filterId} x="0" y="0" width="1254" height="1254" colorInterpolationFilters="sRGB" filterUnits="userSpaceOnUse">
          <feColorMatrix
            in="SourceGraphic"
            type="matrix"
            values="1 0 0 0 0
                    0 1 0 0 0
                    0 0 1 0 0
                    1 1 1 0 -0.035"
          />
        </filter>
      </defs>
      <image
        href={`${import.meta.env.BASE_URL}branding/li3d-logo-dark-source.png?v=li3d-stacked-20260825`}
        width="1254"
        height="1254"
        preserveAspectRatio="xMidYMid meet"
        filter={`url(#${filterId})`}
      />
    </svg>
  );
}
