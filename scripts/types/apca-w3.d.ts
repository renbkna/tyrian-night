declare module 'apca-w3' {
  export function calcAPCA(
    textColor: string,
    backgroundColor: string,
    places?: number,
    isInt?: boolean
  ): number | string;

  export function fontLookupAPCA(contrast: number): Array<number | string>;
}
