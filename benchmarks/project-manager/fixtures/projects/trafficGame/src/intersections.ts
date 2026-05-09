export type Edge = {
  id: string;
  fromIntersectionId: string;
  toIntersectionId: string;
  capacity: number;
};

export type Intersection = {
  id: string;
  edgesOut: Edge[];
};
