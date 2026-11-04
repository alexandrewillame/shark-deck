/**
 * The slice of the WebHID API (https://wicg.github.io/webhid/) the browser
 * edition uses. TypeScript's DOM lib does not ship it, and a hand-written
 * subset keeps the dependency list as it is. Extend it when a new member is
 * needed; everything here is Chromium's shape as of Chrome 153.
 */
export {};

declare global {
  interface HIDReportItem {
    readonly reportSize?: number;
    readonly reportCount?: number;
    readonly usages?: number[];
    readonly isRange?: boolean;
  }

  interface HIDReportInfo {
    readonly reportId?: number;
    readonly items?: HIDReportItem[];
  }

  interface HIDCollectionInfo {
    readonly usagePage?: number;
    readonly usage?: number;
    readonly type?: number;
    readonly children?: HIDCollectionInfo[];
    readonly inputReports?: HIDReportInfo[];
    readonly outputReports?: HIDReportInfo[];
    readonly featureReports?: HIDReportInfo[];
  }

  interface HIDInputReportEvent extends Event {
    readonly device: HIDDevice;
    readonly reportId: number;
    readonly data: DataView;
  }

  interface HIDConnectionEvent extends Event {
    readonly device: HIDDevice;
  }

  interface HIDDeviceEventMap {
    inputreport: HIDInputReportEvent;
  }

  interface HIDDevice extends EventTarget {
    readonly opened: boolean;
    readonly vendorId: number;
    readonly productId: number;
    readonly productName: string;
    readonly collections: HIDCollectionInfo[];
    open(): Promise<void>;
    close(): Promise<void>;
    /** Revokes this origin's permission for the device (Chrome 100+). */
    forget(): Promise<void>;
    sendReport(reportId: number, data: BufferSource): Promise<void>;
    sendFeatureReport(reportId: number, data: BufferSource): Promise<void>;
    receiveFeatureReport(reportId: number): Promise<DataView>;
    addEventListener<K extends keyof HIDDeviceEventMap>(
      type: K,
      listener: (this: HIDDevice, ev: HIDDeviceEventMap[K]) => unknown,
      options?: boolean | AddEventListenerOptions,
    ): void;
    addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ): void;
    removeEventListener<K extends keyof HIDDeviceEventMap>(
      type: K,
      listener: (this: HIDDevice, ev: HIDDeviceEventMap[K]) => unknown,
      options?: boolean | EventListenerOptions,
    ): void;
    removeEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ): void;
  }

  interface HIDDeviceFilter {
    vendorId?: number;
    productId?: number;
    usagePage?: number;
    usage?: number;
  }

  interface HIDDeviceRequestOptions {
    filters: HIDDeviceFilter[];
    exclusionFilters?: HIDDeviceFilter[];
  }

  interface HIDEventMap {
    connect: HIDConnectionEvent;
    disconnect: HIDConnectionEvent;
  }

  interface HID extends EventTarget {
    getDevices(): Promise<HIDDevice[]>;
    requestDevice(options: HIDDeviceRequestOptions): Promise<HIDDevice[]>;
    addEventListener<K extends keyof HIDEventMap>(
      type: K,
      listener: (this: HID, ev: HIDEventMap[K]) => unknown,
      options?: boolean | AddEventListenerOptions,
    ): void;
    addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ): void;
    removeEventListener<K extends keyof HIDEventMap>(
      type: K,
      listener: (this: HID, ev: HIDEventMap[K]) => unknown,
      options?: boolean | EventListenerOptions,
    ): void;
    removeEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ): void;
  }

  interface Navigator {
    /** Absent outside Chromium desktop browsers (and in insecure contexts). */
    readonly hid?: HID;
  }
}
