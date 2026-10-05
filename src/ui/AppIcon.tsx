import {
  Activity,
  AudioLines,
  Circle,
  CircleAlert,
  Crosshair,
  Download,
  FileText,
  FolderOpen,
  Headphones,
  Info,
  Pause,
  Play,
  Plug,
  Radio,
  RotateCcw,
  Search,
  Settings,
  SlidersHorizontal,
  Square,
  Trash2,
  Unplug,
  Volume2,
  VolumeX,
  ChevronDown,
  ChevronUp,
  CircleHelp,
  type LucideIcon,
} from "lucide-react";

const icons = {
  activity: Activity,
  audio: AudioLines,
  alert: CircleAlert,
  crosshair: Crosshair,
  download: Download,
  file: FileText,
  folder: FolderOpen,
  headphones: Headphones,
  help: CircleHelp,
  info: Info,
  pause: Pause,
  play: Play,
  plug: Plug,
  radio: Radio,
  record: Circle,
  retry: RotateCcw,
  search: Search,
  settings: Settings,
  sliders: SlidersHorizontal,
  stop: Square,
  trash: Trash2,
  unplug: Unplug,
  volume: Volume2,
  mute: VolumeX,
  expand: ChevronDown,
  collapse: ChevronUp,
} satisfies Record<string, LucideIcon>;

export type AppIconName = keyof typeof icons;

/** Decorative icons supplement visible labels without changing accessible names. */
export function AppIcon({ name }: { name: AppIconName }) {
  const Icon = icons[name];
  return (
    <Icon
      className={`app-icon app-icon-${name}`}
      size={16}
      strokeWidth={1.8}
      aria-hidden="true"
      focusable="false"
    />
  );
}
