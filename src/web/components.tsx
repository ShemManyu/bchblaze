import { useEffect, useId, useRef, type ReactNode } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  CircleHelp,
  Copy,
  X,
} from 'lucide-react';
import { shortHex } from '../shared/format.js';
import type { CircleStatus } from '../shared/types.js';

export function Modal({
  title,
  children,
  onClose,
  wide = false,
  closeDisabled = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  closeDisabled?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const node = dialog.current!;
    node.showModal();
    return () => node.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className={`modal ${wide ? 'modal-wide' : ''}`}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!closeDisabled) onClose();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget || closeDisabled) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        )
          onClose();
      }}
    >
      <header className="modal-header">
        <div>
          <span className="eyebrow">SWAPCIRCLE</span>
          <h2 id={titleId}>{title}</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Close dialog"
          disabled={closeDisabled}
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </header>
      {children}
    </dialog>
  );
}

const palettes = [
  ['#bcf171', '#425e39', '#172b24'],
  ['#a7b5ff', '#55527a', '#25243f'],
  ['#ffb38b', '#744f40', '#362820'],
  ['#84dcd0', '#3a6260', '#193532'],
  ['#e7a5d4', '#69445f', '#332334'],
  ['#f2d579', '#70603b', '#302e20'],
];

export function TokenArt({
  category,
  commitment = '',
  compact = false,
}: {
  category: string;
  commitment?: string;
  compact?: boolean;
}) {
  const seed = Number.parseInt(category.slice(0, 6), 16) || 0;
  const palette = palettes[seed % palettes.length]!;
  const id = useId().replaceAll(':', '');
  const rotation = (seed % 4) * 90;
  return (
    <svg
      className={`token-art ${compact ? 'compact' : ''}`}
      viewBox="0 0 300 210"
      role="img"
      aria-label={`Generated token identicon ${shortHex(category)}`}
    >
      <defs>
        <radialGradient id={id}>
          <stop stopColor={palette[1]} />
          <stop offset="1" stopColor={palette[2]} />
        </radialGradient>
        <pattern
          id={`${id}-grid`}
          width="24"
          height="24"
          patternUnits="userSpaceOnUse"
        >
          <path
            d="M24 0H0V24"
            fill="none"
            stroke={palette[0]}
            strokeOpacity=".07"
          />
        </pattern>
      </defs>
      <path d="M0 0H300V210H0Z" fill={`url(#${id})`} />
      <path d="M0 0H300V210H0Z" fill={`url(#${id}-grid)`} />
      <g transform={`rotate(${rotation} 150 106)`}>
        <ellipse
          cx="150"
          cy="106"
          rx="82"
          ry="36"
          transform="rotate(-35 150 106)"
          fill="none"
          stroke={palette[0]}
          strokeOpacity=".5"
          strokeWidth="1.5"
        />
        <ellipse
          cx="150"
          cy="106"
          rx="82"
          ry="36"
          transform="rotate(35 150 106)"
          fill="none"
          stroke={palette[0]}
          strokeOpacity=".3"
          strokeWidth="1.5"
        />
        <path
          d="m150 50 46 27v55l-46 27-46-27V77z"
          fill={palette[0]}
          fillOpacity=".08"
          stroke={palette[0]}
          strokeWidth="1.5"
        />
        <path
          d="m104 77 46 28 46-28M150 105v54"
          fill="none"
          stroke={palette[0]}
          strokeWidth="1.5"
        />
        <path
          d="m150 68 30 18-30 18-30-18z"
          fill={palette[0]}
          fillOpacity=".75"
        />
        <circle cx="217" cy="69" r="4" fill={palette[0]} />
        <circle cx="84" cy="146" r="2.5" fill={palette[0]} />
      </g>
      <text
        x="16"
        y="24"
        fill={palette[0]}
        opacity=".8"
        fontFamily="monospace"
        fontSize="9"
        letterSpacing="2"
      >
        CT / {category.slice(0, 6).toUpperCase()}
      </text>
      <text
        x="16"
        y="193"
        fill={palette[0]}
        opacity=".5"
        fontFamily="monospace"
        fontSize="8"
        letterSpacing="1.4"
      >
        GENERATED IDENTICON
      </text>
      <text
        x="284"
        y="193"
        textAnchor="end"
        fill={palette[0]}
        opacity=".6"
        fontFamily="monospace"
        fontSize="9"
      >
        {commitment.slice(0, 8).toUpperCase() || '00'}
      </text>
    </svg>
  );
}

export interface GraphPerson {
  label: string;
  category: string;
  signed?: boolean;
}

export const examplePeople: [GraphPerson, GraphPerson, GraphPerson] = [
  { label: 'Nova', category: '11'.repeat(32) },
  { label: 'Kai', category: '22'.repeat(32) },
  { label: 'Remi', category: '33'.repeat(32) },
];

export function CircleGraph({
  people = examplePeople,
  live = false,
  settled = false,
}: {
  people?: readonly GraphPerson[];
  live?: boolean;
  settled?: boolean;
}) {
  const id = useId().replaceAll(':', '');
  const positions = [
    [260, 74],
    [105, 302],
    [415, 302],
  ];
  const count = people.filter((person) => person.signed).length;
  return (
    <div
      className={`circle-graph ${live ? 'graph-live' : ''} ${settled ? 'graph-settled' : ''}`}
    >
      <svg
        viewBox="0 0 520 405"
        role="img"
        aria-label={
          live
            ? `Three-party circle, ${count} of 3 approved`
            : 'Example: Nova wants Kai, Kai wants Remi, Remi wants Nova'
        }
      >
        <defs>
          <marker
            id={id}
            markerWidth="7"
            markerHeight="7"
            refX="5"
            refY="3"
            orient="auto"
          >
            <path
              d="m0 0 6 3-6 3"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
            />
          </marker>
        </defs>
        <circle cx="260" cy="214" r="123" className="graph-orbit" />
        <circle cx="260" cy="214" r="164" className="graph-orbit outer" />
        <g
          className="graph-paths"
          fill="none"
          strokeWidth="1.5"
          markerEnd={`url(#${id})`}
        >
          <path d="M306 110 Q405 153 416 254" />
          <path d="M368 320 Q260 370 152 320" />
          <path d="M103 253 Q112 151 213 109" />
        </g>
        <text
          x="260"
          y="198"
          className="graph-center-small"
          textAnchor="middle"
        >
          {settled ? 'CIRCLE CLOSED' : live ? 'APPROVALS' : 'THREE COLLECTORS'}
        </text>
        <text x="260" y="231" className="graph-center" textAnchor="middle">
          {live ? `${count} / 3` : '1 transaction'}
        </text>
        <text
          x="260"
          y="254"
          className="graph-center-small"
          textAnchor="middle"
        >
          {settled ? 'ALL THREE ASSETS MOVED' : 'ALL OR NOTHING'}
        </text>
        {positions.map(([x, y], index) => {
          const person = people[index] ?? examplePeople[index]!;
          const palette =
            palettes[
              (Number.parseInt(person.category.slice(0, 6), 16) || 0) %
                palettes.length
            ]!;
          return (
            <g key={index} transform={`translate(${x! - 56} ${y! - 40})`}>
              <rect
                width="112"
                height="80"
                rx="17"
                fill="#1a201d"
                stroke={person.signed ? '#bcf171' : '#354337'}
              />
              <circle
                cx="56"
                cy="27"
                r="13"
                fill={palette[0]}
                fillOpacity=".14"
                stroke={palette[0]}
                strokeOpacity=".7"
              />
              {person.signed ? (
                <path
                  d="m50 27 4 4 8-8"
                  fill="none"
                  stroke={palette[0]}
                  strokeWidth="2"
                />
              ) : (
                <path
                  d="m56 18 8 5v9l-8 5-8-5v-9z"
                  fill="none"
                  stroke={palette[0]}
                />
              )}
              <text
                x="56"
                y="60"
                textAnchor="middle"
                fill="#edf0e7"
                fontSize="12"
                fontWeight="600"
              >
                {person.label.slice(0, 15)}
              </text>
              <text
                x="56"
                y="98"
                textAnchor="middle"
                fill="#99a596"
                fontSize="9"
                fontFamily="monospace"
              >
                {shortHex(person.category, 4)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

const statusNames: Record<CircleStatus, string> = {
  preparing: 'Checking inputs',
  awaiting_signatures: 'Collecting approvals',
  ready: 'Ready to settle',
  broadcasting: 'Broadcasting',
  broadcast_unknown: 'Outcome uncertain',
  broadcast: 'In mempool',
  confirmed: 'Confirmed',
  cancelled: 'Cancelled',
  expired: 'Expired',
  failed: 'Needs a new circle',
};

export function Status({ status }: { status: CircleStatus }) {
  return (
    <span className={`status status-${status}`}>
      <span />
      {statusNames[status]}
    </span>
  );
}

export function AssetLabel({
  category,
  commitment,
  full = false,
}: {
  category: string;
  commitment: string;
  full?: boolean;
}) {
  return (
    <span className="asset-label">
      <span className="mono">{full ? category : shortHex(category, 5)}</span>
      <span className="commitment">
        #{commitment ? (full ? commitment : shortHex(commitment, 5)) : 'empty'}
      </span>
    </span>
  );
}

export function CopyButton({
  value,
  label = 'Copy',
  onCopy,
}: {
  value: string;
  label?: string;
  onCopy?: () => void;
}) {
  return (
    <button
      type="button"
      className="button button-quiet button-small"
      onClick={() => {
        void navigator.clipboard
          .writeText(value)
          .then(onCopy)
          .catch(() => undefined);
      }}
    >
      <Copy size={14} />
      {label}
    </button>
  );
}

export function Direction({
  send,
  children,
}: {
  send?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`direction ${send ? 'direction-send' : ''}`}>
      {send ? <ArrowUpRight size={17} /> : <ArrowDownLeft size={17} />}
      {children}
    </div>
  );
}

export function SafetyNote({ children }: { children: ReactNode }) {
  return (
    <div className="safety-note">
      <CircleHelp size={17} />
      <div>{children}</div>
    </div>
  );
}

export function CheckItem({ children }: { children: ReactNode }) {
  return (
    <div className="check-item">
      <Check size={16} />
      {children}
    </div>
  );
}
