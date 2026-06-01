export type StopEvent = {
  bpuic: number;
  schedArr: number | null;
  actArr: number | null;
  schedDep: number | null;
  actDep: number | null;
};

export type Journey = {
  id: string;
  line: string;
  stops: StopEvent[];
};

export type DayData = {
  date: string;
  /** BPUIC → [lon, lat] */
  stations: Record<number, [number, number]>;
  journeys: Journey[];
};
