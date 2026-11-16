export interface ChangeDTO {
  id: string;
  path: string;
  oldPath: string | null;
  reviewable?: boolean;
  binary?: boolean;
  exists?: boolean;
  beforeSize?: number;
  afterSize?: number;
  before: string | null;
  /** null when this change deleted the file. */
  after: string | null;
  accepted: boolean;
  undone: boolean;
}
