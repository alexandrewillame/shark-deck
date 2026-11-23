<# : Shark Deck - device report. Double-click this file and follow the window.
@echo off
rem  This first part is for cmd.exe: it hands the rest of this file, which is
rem  PowerShell, to the PowerShell built into Windows. Nothing is installed.
setlocal
set "SD_REPORT_SELF=%~f0"
set "SD_REPORT_ARGS=%*"
title Shark Deck - device report
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "& ([ScriptBlock]::Create([IO.File]::ReadAllText($env:SD_REPORT_SELF)))"
exit /b %ERRORLEVEL%
#>

# ============================================================================
#  Shark Deck - device report
#
#  Collects what Shark Deck needs to support a mouse or keyboard it does not
#  know yet. First a report:
#
#   - the USB ids and the names the device reports;
#   - how it talks to the computer (its HID interfaces and their report sizes);
#   - for the families Shark Deck already speaks, the answer to the ONE
#     read-only question the app itself asks every device of that family when
#     it is plugged in: "which model are you?".
#
#  A device of a family Shark Deck knows is picked from what is plugged in;
#  only one of another brand is found by unplugging it and plugging it back in.
#
#  Then a RECORDING: a small window walks you through the official software,
#  one setting at a time, while USBPcap (a free USB capture driver) records
#  what the software and the device say to each other, the device staying
#  plugged in where it is. Only that device's traffic is kept, and what you
#  type on it is blanked as it is recorded, never saved. With a picture of the
#  official software at each step, that recording is what a driver is written
#  from; the report goes into its .zip. USBPcap missing? With your OK, the tool
#  installs it: it downloads the official installer, runs it only if it is byte
#  for byte the file Wireshark ships, makes sure Windows accepts its driver
#  (and takes it out again at once if not), and carries on by itself after the
#  restart.
#
#  The tool itself changes nothing on the device and sends nothing anywhere;
#  its one download is that installer. Never a question to a device of a
#  family Shark Deck does not know, or to a Beken mouse (some of their
#  commands put the mouse into its bootloader). During a recording, only the
#  official software talks to it.
#
#  Usage: double-click. For power users:
#    SharkDeck-device-report.bat --device 1D57:FA55   one device, no unplugging
#    SharkDeck-device-report.bat --all-known          every device of a family Shark Deck knows
#    ... --no-query                                   never ask the model question
#    ... --record / --no-record                       record without asking / never offer it
#    ... --steps deep,macro,specific                  record only the steps whose ids start with
#                                                     these words ('specific': one thing you choose)
#    ... --kind mouse | keyboard                      what the device is (else read from how it is connected)
#    ... --out C:\some\folder                         where the report goes (default: the Desktop)
#    SharkDeck-device-report.bat --preview-steps mouse   walk the recording steps; nothing is recorded
#                                                     (with --steps: only those, as a demo device shows them)
#    SharkDeck-device-report.bat --resume-recording      carry on with a recording set aside for a restart
#
#  Part of Shark Deck (GPL-3.0-or-later): https://github.com/alexandrewillame/shark-deck
# ============================================================================

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

$ToolVersion = 2
$IssueUrl = 'https://github.com/alexandrewillame/shark-deck/issues/new?template=new-device.yml'
$IssuesUrl = 'https://github.com/alexandrewillame/shark-deck/issues'
# Where USBPcap is published: the one page outside the project this tool opens.
$UsbPcapUrl = 'https://github.com/desowin/usbpcap/releases'
# The tool's one download: USBPcap 1.5.4.0, the release Wireshark ships. It is
# run only if its SHA-256 is the one in Wireshark's own dependency index
# (dev-libs.wireshark.org/windows/packages/USBPcap).
$UsbPcapInstallerUrl = 'https://github.com/desowin/usbpcap/releases/download/1.5.4.0/USBPcapSetup-1.5.4.0.exe'
$UsbPcapInstallerSha256 = '87A7EDF9BBBCF07B5F4373D9A192A6770D2FF3ADD7AA1E276E82E38582CCB622'
# After a restart, Windows opens the tool once more: a sign-in task of this name.
$ResumeName = 'SharkDeckDeviceReport'

# ---- What Shark Deck knows ---------------------------------------------------
# The same families, interfaces and frames as the app. Pinned to it by
# app/test/contract/device-report-tool.test.ts: change the app, and that test
# says what to change here.
$KnownVendorIds = @(0x3151, 0x39AB, 0x3554, 0x373E, 0x1D57)
$RoyuanVendorIds = @(0x3151, 0x39AB)
# 0x3151 receivers that pass every question on to their device: the model
# number has to be asked through that relay, which this tool does not do.
$RoyuanRelayPids = @(0x4011, 0x402D)
$RoyuanUsagePage = 0xFFFF
$RoyuanUsage = 0x0002
$RoyuanReportBytes = 65
# GET_USB_VERSION (0x8F): feature report 0, checksum at byte 8.
$RoyuanIdentifyHex = '008f000000000000700000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000'
$HubVendorId = 0x3554
$HubUsagePage = 0xFF02
$HubUsage = 0x0002
$HubReportBytes = 17
# IDENTIFY (0x01): output report 8, a 4-byte nonce at bytes 6-9, shark-sum last.
$HubIdentifyHex = '0801000000085d2a710c00000000000040'
$JxcVendorId = 0x373E
$BekenVendorId = 0x1D57
# Families whose language Shark Deck speaks: a report alone is usually enough.
$SpokenFamilies = @('royuan', 'compx-hub', 'jxc')

# ---- Windows HID, USBPcap recordings, the step window -------------------------
Add-Type -Language CSharp -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32.SafeHandles;

public class SdHidInterface {
    public string Path;
    public int Vid, Pid, Release;
    public string Product, Manufacturer;
    public bool HasSerial;
    public int UsagePage, Usage, InputBytes, OutputBytes, FeatureBytes;
    public int[] InputIds = new int[0], OutputIds = new int[0], FeatureIds = new int[0];
    public string Error;
}

public static class SdHid {
    [StructLayout(LayoutKind.Sequential)]
    struct InterfaceData { public int cbSize; public Guid ClassGuid; public int Flags; public IntPtr Reserved; }

    [StructLayout(LayoutKind.Sequential)]
    struct Attributes { public int Size; public ushort VendorId; public ushort ProductId; public ushort Version; }

    [StructLayout(LayoutKind.Sequential)]
    struct Caps {
        public ushort Usage, UsagePage, InputReportByteLength, OutputReportByteLength, FeatureReportByteLength;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 17)] public ushort[] Reserved;
        public ushort NumberLinkCollectionNodes, NumberInputButtonCaps, NumberInputValueCaps, NumberInputDataIndices;
        public ushort NumberOutputButtonCaps, NumberOutputValueCaps, NumberOutputDataIndices;
        public ushort NumberFeatureButtonCaps, NumberFeatureValueCaps, NumberFeatureDataIndices;
    }

    [DllImport("hid.dll")] static extern void HidD_GetHidGuid(out Guid guid);
    [DllImport("hid.dll", SetLastError = true)] static extern bool HidD_GetAttributes(SafeFileHandle h, ref Attributes a);
    [DllImport("hid.dll", SetLastError = true)] static extern bool HidD_GetPreparsedData(SafeFileHandle h, out IntPtr p);
    [DllImport("hid.dll")] static extern bool HidD_FreePreparsedData(IntPtr p);
    [DllImport("hid.dll")] static extern int HidP_GetCaps(IntPtr p, out Caps c);
    [DllImport("hid.dll")] static extern int HidP_GetButtonCaps(int type, byte[] caps, ref ushort count, IntPtr p);
    [DllImport("hid.dll")] static extern int HidP_GetValueCaps(int type, byte[] caps, ref ushort count, IntPtr p);
    [DllImport("hid.dll", SetLastError = true)] static extern bool HidD_GetProductString(SafeFileHandle h, byte[] buf, int len);
    [DllImport("hid.dll", SetLastError = true)] static extern bool HidD_GetManufacturerString(SafeFileHandle h, byte[] buf, int len);
    [DllImport("hid.dll", SetLastError = true)] static extern bool HidD_GetSerialNumberString(SafeFileHandle h, byte[] buf, int len);
    [DllImport("hid.dll", SetLastError = true)] static extern bool HidD_SetFeature(SafeFileHandle h, byte[] buf, int len);
    [DllImport("hid.dll", SetLastError = true)] static extern bool HidD_GetFeature(SafeFileHandle h, byte[] buf, int len);
    [DllImport("setupapi.dll", SetLastError = true)] static extern IntPtr SetupDiGetClassDevs(ref Guid g, IntPtr e, IntPtr w, int flags);
    [DllImport("setupapi.dll", SetLastError = true)] static extern bool SetupDiEnumDeviceInterfaces(IntPtr set, IntPtr info, ref Guid g, int i, ref InterfaceData d);
    [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool SetupDiGetDeviceInterfaceDetail(IntPtr set, ref InterfaceData d, IntPtr detail, int size, out int required, IntPtr info);
    [DllImport("setupapi.dll")] static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr sec, uint disposition, uint flags, IntPtr template);

    const uint ShareReadWrite = 3, OpenExisting = 3, ReadWrite = 0xC0000000, Overlapped = 0x40000000;

    /** Every HID interface present right now, by its device path. */
    public static List<string> Paths() {
        Guid g; HidD_GetHidGuid(out g);
        IntPtr set = SetupDiGetClassDevs(ref g, IntPtr.Zero, IntPtr.Zero, 0x12);
        List<string> list = new List<string>();
        try {
            InterfaceData d = new InterfaceData(); d.cbSize = Marshal.SizeOf(typeof(InterfaceData));
            for (int i = 0; SetupDiEnumDeviceInterfaces(set, IntPtr.Zero, ref g, i, ref d); i++) {
                int required;
                SetupDiGetDeviceInterfaceDetail(set, ref d, IntPtr.Zero, 0, out required, IntPtr.Zero);
                IntPtr buf = Marshal.AllocHGlobal(required);
                try {
                    Marshal.WriteInt32(buf, IntPtr.Size == 8 ? 8 : 6);
                    if (SetupDiGetDeviceInterfaceDetail(set, ref d, buf, required, out required, IntPtr.Zero))
                        list.Add(Marshal.PtrToStringUni(new IntPtr(buf.ToInt64() + 4)));
                } finally { Marshal.FreeHGlobal(buf); }
            }
        } finally { SetupDiDestroyDeviceInfoList(set); }
        return list;
    }

    static string Text(SafeFileHandle h, int which) {
        byte[] buf = new byte[512];
        bool ok = which == 0 ? HidD_GetProductString(h, buf, buf.Length)
            : which == 1 ? HidD_GetManufacturerString(h, buf, buf.Length)
            : HidD_GetSerialNumberString(h, buf, buf.Length);
        if (!ok) return null;
        string s = System.Text.Encoding.Unicode.GetString(buf);
        int end = s.IndexOf('\0');
        return (end >= 0 ? s.Substring(0, end) : s).Trim();
    }

    static int[] ReportIds(int type, int buttons, int values, IntPtr p) {
        SortedSet<int> ids = new SortedSet<int>();
        // HIDP_BUTTON_CAPS and HIDP_VALUE_CAPS are 72 bytes; ReportID is byte 2.
        if (buttons > 0) {
            ushort n = (ushort)buttons; byte[] caps = new byte[72 * buttons];
            if (HidP_GetButtonCaps(type, caps, ref n, p) == 0x110000) for (int i = 0; i < n; i++) ids.Add(caps[i * 72 + 2]);
        }
        if (values > 0) {
            ushort n = (ushort)values; byte[] caps = new byte[72 * values];
            if (HidP_GetValueCaps(type, caps, ref n, p) == 0x110000) for (int i = 0; i < n; i++) ids.Add(caps[i * 72 + 2]);
        }
        return new List<int>(ids).ToArray();
    }

    /** What one interface says about itself. Opened with no access rights: nothing is sent. */
    public static SdHidInterface Describe(string path) {
        SdHidInterface r = new SdHidInterface(); r.Path = path;
        using (SafeFileHandle h = CreateFile(path, 0, ShareReadWrite, IntPtr.Zero, OpenExisting, 0, IntPtr.Zero)) {
            if (h.IsInvalid) { r.Error = "could not open (" + Marshal.GetLastWin32Error() + ")"; return r; }
            Attributes a = new Attributes(); a.Size = Marshal.SizeOf(typeof(Attributes));
            if (HidD_GetAttributes(h, ref a)) { r.Vid = a.VendorId; r.Pid = a.ProductId; r.Release = a.Version; }
            r.Product = Text(h, 0);
            r.Manufacturer = Text(h, 1);
            r.HasSerial = !string.IsNullOrEmpty(Text(h, 2));
            IntPtr p;
            if (HidD_GetPreparsedData(h, out p)) {
                try {
                    Caps c;
                    if (HidP_GetCaps(p, out c) == 0x110000) {
                        r.UsagePage = c.UsagePage; r.Usage = c.Usage;
                        r.InputBytes = c.InputReportByteLength; r.OutputBytes = c.OutputReportByteLength; r.FeatureBytes = c.FeatureReportByteLength;
                        r.InputIds = ReportIds(0, c.NumberInputButtonCaps, c.NumberInputValueCaps, p);
                        r.OutputIds = ReportIds(1, c.NumberOutputButtonCaps, c.NumberOutputValueCaps, p);
                        r.FeatureIds = ReportIds(2, c.NumberFeatureButtonCaps, c.NumberFeatureValueCaps, p);
                    }
                } finally { HidD_FreePreparsedData(p); }
            }
        }
        return r;
    }

    static bool Same(byte[] a, byte[] b) {
        if (a.Length != b.Length) return false;
        for (int i = 0; i < a.Length; i++) if (a[i] != b[i]) return false;
        return true;
    }

    /** A feature-report question (ROYUAN 0x8F): the reply with the same command
     *  byte that is not just the question echoed back (Windows hands that back
     *  until the firmware has answered). Null when it never answers. */
    public static byte[] AskFeature(string path, byte[] query) {
        using (SafeFileHandle h = CreateFile(path, ReadWrite, ShareReadWrite, IntPtr.Zero, OpenExisting, 0, IntPtr.Zero)) {
            if (h.IsInvalid) throw new IOException("could not open it to ask (" + Marshal.GetLastWin32Error() + ") - is Shark Deck or the vendor software running?");
            for (int round = 0; round < 3; round++) {
                if (!HidD_SetFeature(h, query, query.Length)) { Thread.Sleep(60); continue; }
                for (int read = 0; read < 4; read++) {
                    Thread.Sleep(40);
                    byte[] r = new byte[query.Length]; r[0] = query[0];
                    if (HidD_GetFeature(h, r, r.Length) && r[1] == query[1] && !Same(r, query)) return r;
                }
            }
            return null;
        }
    }

    /** An output-report question (Compx Hub 0x01): the input report that answers it
     *  (same command byte, status 0, a valid shark-sum), within the time given. */
    public static byte[] AskOutput(string path, byte[] query, int inputBytes, int timeoutMs) {
        using (SafeFileHandle h = CreateFile(path, ReadWrite, ShareReadWrite, IntPtr.Zero, OpenExisting, Overlapped, IntPtr.Zero)) {
            if (h.IsInvalid) throw new IOException("could not open it to ask (" + Marshal.GetLastWin32Error() + ") - is Shark Deck or the vendor software running?");
            using (FileStream fs = new FileStream(h, FileAccess.ReadWrite, Math.Max(inputBytes, query.Length), true)) {
                fs.Write(query, 0, query.Length);
                DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
                while (DateTime.UtcNow < deadline) {
                    byte[] buf = new byte[inputBytes];
                    System.Threading.Tasks.Task<int> t = fs.ReadAsync(buf, 0, inputBytes);
                    int left = (int)(deadline - DateTime.UtcNow).TotalMilliseconds;
                    if (left <= 0 || !t.Wait(left)) break;
                    if (t.Result >= 13 && buf[0] == query[0] && buf[1] == query[1] && buf[2] == 0 && SharkSumOk(buf)) return buf;
                }
                return null;
            }
        }
    }

    static bool SharkSumOk(byte[] f) {
        int sum = 0;
        for (int i = 0; i < f.Length - 1; i++) sum += f[i];
        return ((0x55 - sum) & 0xFF) == f[f.Length - 1];
    }
}

/** Where a USB device is plugged in: its address on its bus and that bus's
 *  root hub, as the USB hub driver has known them since the device was plugged
 *  in (the device itself is asked nothing), and the root hub each USBPcap
 *  recorder listens on. With them a recording takes a device where it is,
 *  instead of having it unplugged and plugged back in. */
public class SdUsbPlace { public int Address, Port; public string Hub, RootHub; }

public static class SdUsb {
    static Guid hubInterface = new Guid("f18a0e88-c30c-11d0-8815-00a0c906bed8"); // GUID_DEVINTERFACE_USB_HUB
    [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)] static extern int CM_Locate_DevNodeW(out uint node, string id, int flags);
    [DllImport("cfgmgr32.dll")] static extern int CM_Get_Parent(out uint parent, uint node, int flags);
    [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)] static extern int CM_Get_Device_IDW(uint node, System.Text.StringBuilder id, int length, int flags);
    [DllImport("cfgmgr32.dll")] static extern int CM_Get_DevNode_Registry_PropertyW(uint node, int property, out int type, byte[] value, ref int length, int flags);
    [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)] static extern int CM_Get_Device_Interface_List_SizeW(out int length, ref Guid iface, string id, int flags);
    [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)] static extern int CM_Get_Device_Interface_ListW(ref Guid iface, string id, char[] list, int length, int flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool DeviceIoControl(SafeFileHandle handle, uint code, byte[] input, int inputLength, byte[] output, int outputLength, out int returned, IntPtr overlapped);

    static string IdOf(uint node) {
        System.Text.StringBuilder id = new System.Text.StringBuilder(512);
        return CM_Get_Device_IDW(node, id, id.Capacity, 0) == 0 ? id.ToString() : "";
    }

    static string HubPath(string id) {
        int length;
        if (CM_Get_Device_Interface_List_SizeW(out length, ref hubInterface, id, 0) != 0 || length <= 1) return null;
        char[] list = new char[length];
        if (CM_Get_Device_Interface_ListW(ref hubInterface, id, list, length, 0) != 0) return null;
        string all = new string(list);
        int end = all.IndexOf('\0');
        return end > 0 ? all.Substring(0, end) : null;
    }

    /** The place of the USB device one of these HID interfaces belongs to, or null. */
    public static SdUsbPlace Locate(string hidPath, int vid, int pid) {
        // \\?\hid#vid_3151&pid_5029&mi_02#9&31baff17&0&0000#{...} is HID\VID_3151&PID_5029&MI_02\9&31BAFF17&0&0000
        string[] parts = hidPath.Substring(4).Split('#');
        if (parts.Length < 3) return null;
        uint node;
        if (CM_Locate_DevNodeW(out node, parts[0] + "\\" + parts[1] + "\\" + parts[2], 0) != 0) return null;
        // Up to the USB device itself: the first USB node that is not one of its interfaces.
        string id = IdOf(node);
        while (!(id.StartsWith("USB\\", StringComparison.OrdinalIgnoreCase) && id.IndexOf("&MI_", StringComparison.OrdinalIgnoreCase) < 0)) {
            if (CM_Get_Parent(out node, node, 0) != 0) return null;
            id = IdOf(node);
            if (id.Length == 0) return null;
        }
        int type, length = 4;
        byte[] value = new byte[4];
        if (CM_Get_DevNode_Registry_PropertyW(node, 0x1D, out type, value, ref length, 0) != 0) return null; // CM_DRP_ADDRESS: its port
        int port = BitConverter.ToInt32(value, 0);
        uint hub;
        if (CM_Get_Parent(out hub, node, 0) != 0) return null;
        string hubPath = HubPath(IdOf(hub));
        if (hubPath == null) return null;
        // The root hub of its bus.
        uint up = hub;
        string upId = IdOf(up);
        while (!upId.StartsWith("USB\\ROOT_HUB", StringComparison.OrdinalIgnoreCase)) {
            if (CM_Get_Parent(out up, up, 0) != 0) return null;
            upId = IdOf(up);
            if (upId.Length == 0) return null;
        }
        string rootPath = HubPath(upId);
        if (rootPath == null) return null;
        // The hub's own account of that port: the device's USB ids, to be sure, and its address.
        using (SafeFileHandle h = CreateFileW(hubPath, 0x40000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero)) {
            if (h.IsInvalid) return null;
            byte[] info = new byte[512];
            BitConverter.GetBytes(port).CopyTo(info, 0);
            int got;
            if (!DeviceIoControl(h, 0x22040C, info, info.Length, info, info.Length, out got, IntPtr.Zero) || got < 35) return null; // IOCTL_USB_GET_NODE_CONNECTION_INFORMATION
            if (BitConverter.ToUInt16(info, 12) != vid || BitConverter.ToUInt16(info, 14) != pid) return null;
            SdUsbPlace place = new SdUsbPlace();
            place.Address = BitConverter.ToUInt16(info, 25);
            place.Port = port;
            place.Hub = hubPath;
            place.RootHub = rootPath;
            return place.Address > 0 ? place : null;
        }
    }

    /** The root hub a USBPcap recorder (\\.\USBPcapN) listens on, or null. */
    public static string UsbPcapRootHub(string control) {
        foreach (uint access in new uint[] { 0, 0x80000000 }) {
            using (SafeFileHandle h = CreateFileW(control, access, 3, IntPtr.Zero, 3, 0, IntPtr.Zero)) {
                if (h.IsInvalid) continue;
                byte[] link = new byte[2048];
                int got;
                if (!DeviceIoControl(h, 0x22200C, null, 0, link, link.Length, out got, IntPtr.Zero)) continue; // IOCTL_USBPCAP_GET_HUB_SYMLINK
                return System.Text.Encoding.Unicode.GetString(link, 0, got).TrimEnd('\0');
            }
        }
        return null;
    }

    /** Whether two paths name the same hub (written \??\, \\?\ or \\.\ alike). */
    public static bool SameHub(string a, string b) {
        if (a == null || b == null) return false;
        return Bare(a).Equals(Bare(b), StringComparison.OrdinalIgnoreCase);
    }

    static string Bare(string path) {
        path = path.Trim('\0', ' ');
        foreach (string prefix in new string[] { "\\\\?\\", "\\??\\", "\\\\.\\" })
            if (path.StartsWith(prefix)) return path.Substring(prefix.Length);
        return path;
    }
}

// ---- Recording: below this line nothing writes to a device. USBPcap records
// passively; the official software is the only thing talking to the device.

/** USBPcapCMD processes end with this one, even if its window is closed mid-recording. */
public static class SdJob {
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong A, B, C, D, E, F; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits { public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, int size);
    [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    static IntPtr job = IntPtr.Zero;

    public static bool Adopt(Process p) {
        if (job == IntPtr.Zero) {
            job = CreateJobObject(IntPtr.Zero, null);
            ExtendedLimits info = new ExtendedLimits();
            info.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            SetInformationJobObject(job, 9, ref info, Marshal.SizeOf(typeof(ExtendedLimits)));
        }
        return AssignProcessToJobObject(job, p.Handle);
    }

    [StructLayout(LayoutKind.Sequential)] struct UiLimits { public uint Restrictions; }
    [DllImport("kernel32.dll", EntryPoint = "SetInformationJobObject")] static extern bool SetUiLimits(IntPtr job, int infoClass, ref UiLimits info, int size);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo { public int cb; public string reserved, desktop, title; public int x, y, width, height, columns, rows, fill, flags; public short show, reserved2; public IntPtr reserved3, stdin, stdout, stderr; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process, thread; public int processId, threadId; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string application, System.Text.StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInfo info);
    [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    /** Runs an installer, and all it starts, unable to restart the computer:
     *  Windows refuses them ExitWindowsEx, which its "restart now?" prompt
     *  calls, so the tool checks the driver before any restart. Started
     *  suspended, so it is fenced before it runs at all. Returns its exit code. */
    public static int RunNoRestart(string path, string arguments, out bool fenced) {
        IntPtr fence = CreateJobObject(IntPtr.Zero, null);
        UiLimits ui = new UiLimits();
        ui.Restrictions = 0x80; // JOB_OBJECT_UILIMIT_EXITWINDOWS
        fenced = fence != IntPtr.Zero && SetUiLimits(fence, 4, ref ui, Marshal.SizeOf(typeof(UiLimits))); // JobObjectBasicUIRestrictions
        StartupInfo si = new StartupInfo();
        si.cb = Marshal.SizeOf(typeof(StartupInfo));
        ProcessInfo pi;
        if (!CreateProcess(path, new System.Text.StringBuilder("\"" + path + "\" " + arguments), IntPtr.Zero, IntPtr.Zero, false, 0x4, IntPtr.Zero, null, ref si, out pi)) {
            int error = Marshal.GetLastWin32Error();
            if (fence != IntPtr.Zero) CloseHandle(fence);
            throw new System.ComponentModel.Win32Exception(error);
        }
        try {
            fenced = fenced && AssignProcessToJobObject(fence, pi.process);
            ResumeThread(pi.thread);
            WaitForSingleObject(pi.process, 0xFFFFFFFF);
            uint code;
            GetExitCodeProcess(pi.process, out code);
            return (int)code;
        } finally {
            CloseHandle(pi.thread);
            CloseHandle(pi.process);
            if (fence != IntPtr.Zero) CloseHandle(fence);
        }
    }
}

public class SdPcapResult {
    public int Kept, Dropped, KeyboardBlanked, MouseThinned, SerialBlanked, Unidentified;
    public List<string> Devices = new List<string>();
}

/** USBPcap files (pcap, link type 249) narrowed to the recorded device:
 *  every other device dropped, its serial number and what is typed on it
 *  blanked, mouse movement cut to a sample. */
public static class SdPcap {
    class Rule { public string Device; public int Iface; public string Kind; public int[] Ids; }
    static readonly List<Rule> rules = new List<Rule>();
    // The recorders read the rules on their own threads while they are set.
    static readonly object gate = new object();

    public static void ClearRules() { lock (gate) rules.Clear(); }

    /** An input collection to keep private: "keyboard" (blanked) or "mouse" (a
     *  sample kept), on one interface, for these report ids (none = all). */
    public static void AddRule(string device, int iface, string kind, int[] ids) {
        Rule r = new Rule(); r.Device = device.ToUpperInvariant(); r.Iface = iface; r.Kind = kind; r.Ids = ids == null ? new int[0] : ids;
        lock (gate) rules.Add(r);
    }

    /** The same rules while recording, one message at a time: what is typed on a
     *  keyboard collection is blanked before it is written anywhere, and the
     *  step window counts only the rest (typing and pointer movement are not
     *  what the official software says). See() answers 1 for a message to the
     *  device, 2 for one from it, 0 for anything else. */
    public class Live {
        readonly Dictionary<int, Dev> devs = new Dictionary<int, Dev>();
        readonly Dictionary<ulong, byte[]> setups = new Dictionary<ulong, byte[]>();

        public int See(byte[] rec) {
            int hl = BitConverter.ToUInt16(rec, 16);
            if (hl < 27 || 16 + hl > rec.Length) return 0;
            ulong irp = BitConverter.ToUInt64(rec, 18);
            bool up = (rec[32] & 1) == 1;
            int bus = BitConverter.ToUInt16(rec, 33), addr = BitConverter.ToUInt16(rec, 35);
            int ep = rec[37], transfer = rec[38];
            int at = 16 + hl;
            int len = (int)Math.Min((long)BitConverter.ToUInt32(rec, 39), (long)(rec.Length - at));
            int key = (bus << 16) | addr;
            Dev d;
            if (!devs.TryGetValue(key, out d)) { d = new Dev(); devs[key] = d; }
            if (transfer == 2) {
                int stage = hl >= 28 ? rec[43] : -1;
                if (stage == 0 && !up && len >= 8) {
                    byte[] s = new byte[8]; Buffer.BlockCopy(rec, at, s, 0, 8);
                    setups[irp] = s;
                    return s[0] == 0x21 || s[0] == 0xA1 ? 1 : 0; // a class request: SET_REPORT, GET_REPORT
                }
                byte[] q;
                if (stage == 3 && up && setups.TryGetValue(irp, out q)) {
                    setups.Remove(irp);
                    if (q[0] == 0x80 && q[1] == 6 && q[3] == 1 && len >= 12) {
                        string name = (rec[at + 8] | rec[at + 9] << 8).ToString("X4") + ":" + (rec[at + 10] | rec[at + 11] << 8).ToString("X4");
                        if (d.Known && d.Name != name) { d = new Dev(); devs[key] = d; } // the address went to another device
                        d.Known = true; d.Name = name;
                    } else if (q[0] == 0x80 && q[1] == 6 && q[3] == 2 && len >= 9) ReadConfig(rec, at, len, d);
                }
                return 0;
            }
            if (transfer != 1 || len <= 0) return 0;
            if ((ep & 0x80) == 0) return up ? 0 : 1;
            if (!up) return 0;
            if (!d.Known) return 2;
            int iface;
            if (!d.EpIface.TryGetValue(ep, out iface)) iface = -1;
            Rule rule = RuleFor(d, iface, rec[at]);
            if (rule == null) return 2;
            if (rule.Kind == "keyboard") for (int i = at + (rule.Ids.Length > 0 ? 1 : 0); i < at + len; i++) rec[i] = 0;
            return 0;
        }
    }

    class Dev {
        public bool Known, Target; public string Name = ""; public int Serial; public string Where = "";
        public Dictionary<int, int> EpIface = new Dictionary<int, int>();
        public Dictionary<int, int> BootProtocol = new Dictionary<int, int>();
        public List<byte[]> Pending = new List<byte[]>();
        public Dictionary<string, int> Seen = new Dictionary<string, int>();
    }

    class Reader {
        readonly BinaryReader r; public byte[] Rec; public long Ts; public bool Done;
        public Reader(string path) {
            r = new BinaryReader(new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete));
            byte[] h = r.ReadBytes(24);
            if (h.Length < 24 || BitConverter.ToUInt32(h, 0) != 0xA1B2C3D4u || BitConverter.ToUInt32(h, 20) != 249u) { Close(); return; }
            Next();
        }
        public void Next() {
            byte[] rh = r.ReadBytes(16);
            if (rh.Length < 16) { Close(); return; }
            uint incl = BitConverter.ToUInt32(rh, 8);
            if (incl < 27 || incl > (1u << 24)) { Close(); return; }
            byte[] body = r.ReadBytes((int)incl);
            if (body.Length < incl) { Close(); return; } // a recorder stopped mid-record
            Ts = (long)BitConverter.ToUInt32(rh, 0) * 1000000L + BitConverter.ToUInt32(rh, 4);
            Rec = new byte[16 + incl];
            Buffer.BlockCopy(rh, 0, Rec, 0, 16);
            Buffer.BlockCopy(body, 0, Rec, 16, (int)incl);
        }
        public void Close() { if (!Done) { Done = true; r.Close(); } }
    }

    public static SdPcapResult Filter(string[] inputs, string output, string[] targets) {
        SdPcapResult res = new SdPcapResult();
        HashSet<string> want = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (string t in targets) want.Add(t);
        List<Reader> readers = new List<Reader>();
        foreach (string p in inputs) {
            if (!File.Exists(p) || new FileInfo(p).Length < 24) continue;
            Reader rd = new Reader(p);
            if (!rd.Done) readers.Add(rd);
        }
        Dictionary<int, Dev> devs = new Dictionary<int, Dev>();
        Dictionary<ulong, byte[]> setups = new Dictionary<ulong, byte[]>();
        using (FileStream outFile = new FileStream(output, FileMode.Create, FileAccess.Write)) {
            byte[] gh = new byte[24];
            BitConverter.GetBytes(0xA1B2C3D4u).CopyTo(gh, 0);
            BitConverter.GetBytes((ushort)2).CopyTo(gh, 4);
            BitConverter.GetBytes((ushort)4).CopyTo(gh, 6);
            BitConverter.GetBytes(65535u).CopyTo(gh, 16);
            BitConverter.GetBytes(249u).CopyTo(gh, 20);
            outFile.Write(gh, 0, 24);
            while (true) {
                // The recorders write in time order; merge them so the result is too.
                Reader next = null;
                foreach (Reader rd in readers) if (!rd.Done && (next == null || rd.Ts < next.Ts)) next = rd;
                if (next == null) break;
                byte[] rec = next.Rec;
                next.Next();
                Handle(rec, devs, setups, want, outFile, res);
            }
        }
        foreach (Reader rd in readers) rd.Close();
        foreach (Dev d in devs.Values) {
            if (d.Target && res.Devices.IndexOf(d.Where) < 0) res.Devices.Add(d.Where);
            // Never named by a device descriptor: left out, and counted, so the report says so.
            if (!d.Known) { res.Unidentified += d.Pending.Count; res.Dropped += d.Pending.Count; }
        }
        return res;
    }

    static void Write(FileStream to, byte[] rec, SdPcapResult res) { to.Write(rec, 0, rec.Length); res.Kept++; }

    static void Handle(byte[] rec, Dictionary<int, Dev> devs, Dictionary<ulong, byte[]> setups, HashSet<string> want, FileStream to, SdPcapResult res) {
        int hl = BitConverter.ToUInt16(rec, 16);
        if (hl < 27 || 16 + hl > rec.Length) { res.Dropped++; return; }
        ulong irp = BitConverter.ToUInt64(rec, 18);
        bool up = (rec[32] & 1) == 1; // PDO to FDO: a completion
        int bus = BitConverter.ToUInt16(rec, 33), addr = BitConverter.ToUInt16(rec, 35);
        int ep = rec[37], transfer = rec[38];
        int stage = (transfer == 2 && hl >= 28) ? rec[43] : -1;
        int at = 16 + hl;
        int len = (int)Math.Min((long)BitConverter.ToUInt32(rec, 39), (long)(rec.Length - at));
        int key = (bus << 16) | addr;
        Dev d;
        if (!devs.TryGetValue(key, out d)) { d = new Dev(); devs[key] = d; }

        if (transfer == 2 && stage == 0 && !up && len >= 8) {
            byte[] s = new byte[8]; Buffer.BlockCopy(rec, at, s, 0, 8);
            setups[irp] = s;
        } else if (transfer == 2 && stage == 3 && up) {
            byte[] s;
            if (setups.TryGetValue(irp, out s)) {
                setups.Remove(irp);
                if (s[0] == 0x80 && s[1] == 6 && len > 0) {
                    int type = s[3], index = s[2];
                    if (type == 1 && len >= 12) {
                        string name = (rec[at + 8] | rec[at + 9] << 8).ToString("X4") + ":" + (rec[at + 10] | rec[at + 11] << 8).ToString("X4");
                        if (d.Known && d.Name != name) { d = new Dev(); devs[key] = d; } // the address went to another device
                        bool first = !d.Known;
                        d.Known = true; d.Name = name; d.Serial = len >= 17 ? rec[at + 16] : 0;
                        d.Target = want.Contains(name);
                        d.Where = name + " (bus " + bus + ", address " + addr + ")";
                        if (first) {
                            if (d.Target) foreach (byte[] p in d.Pending) Write(to, p, res);
                            else res.Dropped += d.Pending.Count;
                            d.Pending.Clear();
                        }
                    } else if (type == 2 && len >= 9) {
                        ReadConfig(rec, at, len, d);
                    } else if (type == 3 && index != 0 && index == d.Serial && len > 2) {
                        for (int i = at + 2; i < at + len; i++) rec[i] = (byte)((i - at) % 2 == 0 ? 0x30 : 0);
                        res.SerialBlanked++;
                    }
                }
            }
        }
        if (!d.Known) { if (d.Pending.Count < 512) d.Pending.Add(rec); else res.Dropped++; return; }
        if (!d.Target) { res.Dropped++; return; }

        if (transfer == 1 && (ep & 0x80) != 0) {
            int iface;
            if (!d.EpIface.TryGetValue(ep, out iface)) iface = -1;
            Rule rule = RuleFor(d, iface, len > 0 ? rec[at] : -1);
            if (rule != null) {
                if (!up) { res.Dropped++; return; } // a read waiting for input: it carries nothing
                string seen = ep + "/" + (rule.Ids.Length > 0 && len > 0 ? rec[at] : -1);
                int n; d.Seen.TryGetValue(seen, out n); d.Seen[seen] = n + 1;
                if (rule.Kind == "keyboard") {
                    res.KeyboardBlanked++;
                    if (n >= 32) { res.Dropped++; return; }
                    for (int i = at + (rule.Ids.Length > 0 ? 1 : 0); i < at + len; i++) rec[i] = 0;
                } else if (n >= 200) { res.MouseThinned++; return; }
            }
        }
        Write(to, rec, res);
    }

    static Rule RuleFor(Dev d, int iface, int firstByte) {
        bool any = false, keyboard = false;
        Rule[] all;
        lock (gate) all = rules.ToArray();
        foreach (Rule r in all) {
            if (r.Device != d.Name) continue;
            if (r.Kind == "keyboard") keyboard = true;
            if (r.Iface != iface) continue;
            any = true;
            if (r.Ids.Length == 0 || Array.IndexOf(r.Ids, firstByte) >= 0) return r;
        }
        if (any) return null;
        if (iface < 0 && keyboard) {
            // An endpoint no descriptor placed, on a device that types: blank it.
            Rule r = new Rule(); r.Device = d.Name; r.Iface = iface; r.Kind = "keyboard"; r.Ids = new int[0];
            return r;
        }
        // No Windows description of this interface (unplugged before the end):
        // fall back on what its USB descriptor says it is.
        int protocol;
        if (iface >= 0 && d.BootProtocol.TryGetValue(iface, out protocol) && (protocol == 1 || protocol == 2)) {
            Rule r = new Rule(); r.Device = d.Name; r.Iface = iface; r.Kind = protocol == 1 ? "keyboard" : "mouse"; r.Ids = new int[0];
            return r;
        }
        return null;
    }

    static void ReadConfig(byte[] rec, int at, int len, Dev d) {
        int iface = -1;
        for (int i = at; i + 1 < at + len; ) {
            int bl = rec[i], type = rec[i + 1];
            if (bl < 2 || i + bl > at + len) break;
            if (type == 4 && bl >= 9) { iface = rec[i + 2]; if (rec[i + 5] == 3 && rec[i + 6] == 1) d.BootProtocol[iface] = rec[i + 7]; }
            else if (type == 5 && bl >= 7 && iface >= 0) d.EpIface[rec[i + 2]] = iface;
            i += bl;
        }
    }
}

/** Pictures of the official software's windows. */
public static class SdShot {
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
    delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int value, int size);

    public static void DpiAware() { try { SetProcessDPIAware(); } catch (Exception) { } }

    static List<IntPtr> WindowsOf(uint pid) {
        List<IntPtr> list = new List<IntPtr>();
        EnumWindows(delegate (IntPtr h, IntPtr l) {
            uint p; GetWindowThreadProcessId(h, out p);
            if (p != pid || !IsWindowVisible(h) || IsIconic(h)) return true;
            int cloaked = 0;
            try { DwmGetWindowAttribute(h, 14, out cloaked, 4); } catch (Exception) { }
            if (cloaked != 0) return true;
            RECT r;
            if (!GetWindowRect(h, out r) || r.R - r.L < 120 || r.B - r.T < 120) return true;
            list.Add(h);
            return true;
        }, IntPtr.Zero);
        return list;
    }

    public static List<string> Capture(uint pid, string dir, string stem, Dictionary<IntPtr, ulong> last) {
        List<string> files = new List<string>();
        int k = 0;
        foreach (IntPtr h in WindowsOf(pid)) {
            RECT r;
            if (!GetWindowRect(h, out r)) continue;
            int w = r.R - r.L, hh = r.B - r.T;
            byte[] jpg;
            using (Bitmap bmp = new Bitmap(w, hh, PixelFormat.Format24bppRgb)) {
                using (Graphics g = Graphics.FromImage(bmp)) {
                    IntPtr dc = g.GetHdc();
                    bool ok = PrintWindow(h, dc, 2); // PW_RENDERFULLCONTENT
                    g.ReleaseHdc(dc);
                    if (!ok || Blank(bmp)) g.CopyFromScreen(r.L, r.T, 0, 0, new Size(w, hh));
                }
                jpg = Jpeg(bmp);
            }
            ulong hash = Fnv(jpg), before;
            if (last.TryGetValue(h, out before) && before == hash) continue; // nothing changed on it
            last[h] = hash;
            Directory.CreateDirectory(dir);
            string file = Path.Combine(dir, stem + (k == 0 ? "" : "-w" + k) + ".jpg");
            File.WriteAllBytes(file, jpg);
            files.Add(file);
            k++;
        }
        return files;
    }

    /** The biggest window of a program, as a picture held in memory: what the
     *  owner is asked about before any picture is saved. Null if it has none. */
    public static Bitmap Snapshot(uint pid) {
        IntPtr best = IntPtr.Zero; long area = 0; RECT br = new RECT();
        foreach (IntPtr h in WindowsOf(pid)) {
            RECT r;
            if (!GetWindowRect(h, out r)) continue;
            long a = (long)(r.R - r.L) * (r.B - r.T);
            if (a > area) { area = a; best = h; br = r; }
        }
        if (best == IntPtr.Zero) return null;
        int w = br.R - br.L, hh = br.B - br.T;
        Bitmap bmp = new Bitmap(w, hh, PixelFormat.Format24bppRgb);
        using (Graphics g = Graphics.FromImage(bmp)) {
            IntPtr dc = g.GetHdc();
            bool ok = PrintWindow(best, dc, 2); // PW_RENDERFULLCONTENT
            g.ReleaseHdc(dc);
            if (!ok || Blank(bmp)) g.CopyFromScreen(br.L, br.T, 0, 0, new Size(w, hh));
        }
        return bmp;
    }

    static bool Blank(Bitmap b) {
        int sx = Math.Max(1, b.Width / 8), sy = Math.Max(1, b.Height / 8);
        for (int y = sy / 2; y < b.Height; y += sy)
            for (int x = sx / 2; x < b.Width; x += sx) { Color c = b.GetPixel(x, y); if (c.R + c.G + c.B > 0) return false; }
        return true;
    }

    static ulong Fnv(byte[] data) { ulong h = 14695981039346656037UL; foreach (byte x in data) { h ^= x; h *= 1099511628211UL; } return h; }

    static byte[] Jpeg(Bitmap bmp) {
        ImageCodecInfo codec = null;
        foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") codec = c;
        EncoderParameters quality = new EncoderParameters(1);
        quality.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 85L);
        Bitmap src = bmp, scaled = null;
        if (bmp.Width > 1600) { scaled = new Bitmap(bmp, new Size(1600, Math.Max(1, bmp.Height * 1600 / bmp.Width))); src = scaled; }
        try {
            using (MemoryStream ms = new MemoryStream()) { src.Save(ms, codec, quality); return ms.ToArray(); }
        } finally { if (scaled != null) scaled.Dispose(); }
    }
}

/** One USBPcapCMD capture. USBPcapCMD keeps a file it writes to locked, so
 *  the step window could not read it while recording: its capture comes
 *  through its standard output instead ("-o -"), is written to the file one
 *  message at a time, and counted for the step window: messages to the device
 *  (class requests on its control pipe, data on its interrupt OUT pipes) and
 *  reports from it (data on its interrupt IN pipes). What is typed on the
 *  device is blanked before it is written (SdPcap.Live), so it never reaches
 *  the disk, and it is not counted. */
public class SdRecorder {
    public Process Process;
    FileStream file;
    Thread pump;
    long sent, received;
    byte[] pending = new byte[1 << 16];
    int pendingLength;
    bool header = true, lost;
    readonly SdPcap.Live live = new SdPcap.Live();

    public long Sent { get { return Interlocked.Read(ref sent); } }
    public long Received { get { return Interlocked.Read(ref received); } }

    public SdRecorder(string exe, string arguments, string path) {
        file = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.Read);
        ProcessStartInfo psi = new ProcessStartInfo(exe, arguments);
        psi.UseShellExecute = false;
        psi.RedirectStandardOutput = true;
        psi.CreateNoWindow = true;
        Process = Process.Start(psi);
        Stream input = Process.StandardOutput.BaseStream;
        pump = new Thread(delegate () { Pump(input); });
        pump.IsBackground = true;
        pump.Start();
    }

    SdRecorder() { }

    /** A finished capture, counted at once: for previews and tests. */
    public static SdRecorder Replay(string path) {
        SdRecorder r = new SdRecorder();
        byte[] all = File.ReadAllBytes(path);
        r.Take(all, all.Length);
        return r;
    }

    void Pump(Stream input) {
        byte[] buffer = new byte[65536];
        try {
            int n;
            while ((n = input.Read(buffer, 0, buffer.Length)) > 0) Take(buffer, n);
        } catch (Exception) {
        } finally {
            // A message cut short when USBPcapCMD stopped: kept as it came.
            try { if (pendingLength > 0) file.Write(pending, 0, pendingLength); } catch (Exception) { }
            try { file.Dispose(); } catch (Exception) { }
        }
    }

    /** Once USBPcapCMD has ended: waits until all it sent is in the file. */
    public void Finish() {
        if (pump != null) pump.Join(10000);
        if (file != null) try { file.Dispose(); } catch (Exception) { }
    }

    /** Splits what came into messages: each one blanked if typed, counted, then
     *  written (the file is null for a replay). */
    void Take(byte[] data, int n) {
        if (lost) { Write(data, 0, n); return; }
        if (pendingLength + n > pending.Length) {
            byte[] bigger = new byte[Math.Max(pending.Length * 2, pendingLength + n)];
            Buffer.BlockCopy(pending, 0, bigger, 0, pendingLength);
            pending = bigger;
        }
        Buffer.BlockCopy(data, 0, pending, pendingLength, n);
        pendingLength += n;
        int at = 0;
        if (header) {
            if (pendingLength < 24) return;
            Write(pending, 0, 24);
            at = 24;
            header = false;
        }
        while (pendingLength - at >= 16) {
            int incl = BitConverter.ToInt32(pending, at + 8);
            if (incl < 27 || incl > (1 << 24)) {
                // Not a message: counting stops, and the rest goes to the file as it comes.
                lost = true;
                Write(pending, at, pendingLength - at);
                pendingLength = 0;
                return;
            }
            if (pendingLength - at - 16 < incl) break;
            byte[] rec = new byte[16 + incl];
            Buffer.BlockCopy(pending, at, rec, 0, rec.Length);
            int kind = live.See(rec);
            if (kind == 1) Interlocked.Increment(ref sent);
            else if (kind == 2) Interlocked.Increment(ref received);
            Write(rec, 0, rec.Length);
            at += 16 + incl;
        }
        if (file != null) file.Flush();
        Buffer.BlockCopy(pending, at, pending, 0, pendingLength - at);
        pendingLength -= at;
    }

    void Write(byte[] b, int offset, int count) { if (file != null && count > 0) file.Write(b, offset, count); }
}

public class SdStep { public string Id, Kind, Group, Value, Series, Flags, Text; }

public class SdStepResult {
    public string Id, Group, Value, Series, Text, Status, Note, Start, End;
    public int Attempt;
    public List<string> Shots = new List<string>();
}

/** The step window: stays on top, beside the official software. */
public class SdWizard : Form {
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder name, ref int size);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

    // Windows that are never the official software.
    static readonly string[] NotTheSoftware = { "conhost", "windowsterminal", "openconsole", "powershell", "pwsh", "cmd",
        "explorer", "shellexperiencehost", "startmenuexperiencehost", "searchhost", "searchapp", "textinputhost",
        "lockapp", "taskmgr", "systemsettings", "dwm", "rundll32", "consent" };

    readonly List<SdStep> steps;
    readonly string shotsDir, attachDir;
    readonly string[] pcaps;
    readonly HashSet<int> vids;
    readonly HashSet<string> seenPaths;
    readonly int ownPid = Process.GetCurrentProcess().Id;
    public readonly List<SdStepResult> Results = new List<SdStepResult>();
    public readonly List<SdHidInterface> NewInterfaces = new List<SdHidInterface>();
    public string SoftwareName = "", SoftwareTitle = "", SoftwarePath = "";
    public bool FinishedAll, Preview;
    /** The device, as the steps name it ("the R85HE"). */
    public string DeviceName = "device";
    /** A keyboard: the saved window says that what was typed on it is not in the recording. */
    public bool Keyboard;
    /** Where each group's settings usually are, by group name; shown under the step. */
    public readonly Dictionary<string, string> Where = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    uint softwarePid; bool picking = true, closing;
    uint candidatePid; string candidateName = "", candidateTitle = "";
    /** The recorders whose counts the window shows. */
    public SdRecorder[] Recorders = new SdRecorder[0];
    long SentAll { get { long n = 0; foreach (SdRecorder r in Recorders) n += r.Sent; return n; } }
    long ReceivedAll { get { long n = 0; foreach (SdRecorder r in Recorders) n += r.Received; return n; } }
    long stepSent, stepReceived;
    // Redo previous: the step shown again offers "I put it back" first.
    bool redoing, puttingBack;
    // Messages a second the software sends on its own, from the idle step.
    double idleRate;
    int index, attempt, autoLeft, ticks, shotCount;
    DateTime stepStart;
    string lastNew;
    readonly Dictionary<IntPtr, ulong> lastShot = new Dictionary<IntPtr, ulong>();

    // The look: a night header, Shark Cyan for progress and the one main button.
    static readonly Color Ink = Color.FromArgb(27, 39, 51), Muted = Color.FromArgb(91, 102, 112),
        Line = Color.FromArgb(221, 227, 232), Paper = Color.FromArgb(244, 247, 249), Night = Color.FromArgb(11, 30, 45),
        Accent = Color.FromArgb(25, 181, 201), AccentDark = Color.FromArgb(14, 124, 140), Off = Color.FromArgb(201, 211, 218);
    readonly Panel header = new Panel(), progress = new Panel(), content = new Panel(), footer = new Panel();
    readonly Label title = new Label(), groupLabel = new Label(), stepLabel = new Label(), body = new Label(), hint = new Label(),
        noteLabel = new Label(), whereLabel = new Label(), signal = new Label();
    // The footer, one column each: what is recorded, what is pictured. Figures
    // that move as the recording goes; the line under each says what it counts.
    readonly Label recKey = new Label(), recVal = new Label(), recSub = new Label(), picKey = new Label(), picVal = new Label(),
        picSub = new Label();
    // Done is the main button, except while a change is being put back.
    bool doneIsPrimary = true;
    readonly TextBox note = new TextBox();
    readonly Button done = new Button(), skip = new Button(), skipGroup = new Button(), back = new Button(), finish = new Button(), own = new Button();
    readonly ToolTip tips = new ToolTip();
    // Past the last step: the window offers to save (and still to record one more setting).
    bool atEnd;
    // How many settings the owner added with "Record a setting not listed".
    int ownCount;
    readonly LinkLabel change = new LinkLabel(), addNote = new LinkLabel();
    readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
    double progressFraction;
    float dpiScale = 1f;
    // The step needs the value the owner set ("ask", or a list's next entry): Done waits for it.
    bool asking, noteShown;

    public SdWizard(SdStep[] steps, string shotsDir, string attachDir, string[] pcaps, int[] vids, string[] presentPaths) {
        this.steps = new List<SdStep>(steps); this.shotsDir = shotsDir; this.attachDir = attachDir;
        this.pcaps = pcaps == null ? new string[0] : pcaps;
        this.vids = new HashSet<int>(vids == null ? new int[0] : vids);
        this.seenPaths = new HashSet<string>(presentPaths == null ? new string[0] : presentPaths, StringComparer.OrdinalIgnoreCase);

        SuspendLayout();
        AutoScaleDimensions = new SizeF(96F, 96F);
        AutoScaleMode = AutoScaleMode.Dpi;
        Text = "Shark Deck - recording";
        Font = new Font("Segoe UI", 10F);
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        ClientSize = new Size(600, 620);
        BackColor = Color.White;

        header.Dock = DockStyle.Top; header.Height = 64; header.BackColor = Night;
        title.Font = new Font("Segoe UI Semibold", 11F); title.ForeColor = Color.White; title.AutoSize = true; title.Location = new Point(20, 10);
        groupLabel.Font = new Font("Segoe UI Semibold", 9F); groupLabel.ForeColor = Color.FromArgb(111, 211, 224); groupLabel.AutoSize = true; groupLabel.Location = new Point(21, 37);
        stepLabel.Font = new Font("Segoe UI", 9.5F); stepLabel.ForeColor = Color.FromArgb(200, 212, 221); stepLabel.TextAlign = ContentAlignment.MiddleRight;
        stepLabel.Size = new Size(260, 20); stepLabel.Location = new Point(320, 12);
        header.Controls.Add(title); header.Controls.Add(groupLabel); header.Controls.Add(stepLabel);

        progress.Dock = DockStyle.Top; progress.Height = 4; progress.BackColor = Line;
        progress.Paint += delegate (object o, PaintEventArgs e) {
            using (SolidBrush b = new SolidBrush(Accent)) e.Graphics.FillRectangle(b, 0, 0, (int)(progress.Width * progressFraction), progress.Height);
        };

        footer.Dock = DockStyle.Bottom; footer.Height = 96; footer.BackColor = Paper;
        footer.Paint += delegate (object o, PaintEventArgs e) { using (Pen pen = new Pen(Line)) e.Graphics.DrawLine(pen, 0, 0, footer.Width, 0); };
        recKey.Text = "RECORDED"; picKey.Text = "PICTURES";
        foreach (Label k in new Label[] { recKey, picKey }) { k.Font = new Font("Segoe UI Semibold", 7.5F); k.ForeColor = Muted; k.AutoSize = true; footer.Controls.Add(k); }
        foreach (Label v in new Label[] { recVal, picVal }) { v.Font = new Font("Segoe UI Semibold", 13F); v.ForeColor = Ink; v.AutoSize = true; footer.Controls.Add(v); }
        foreach (Label v in new Label[] { recSub, picSub }) { v.Font = new Font("Segoe UI", 8.5F); v.ForeColor = Muted; v.AutoSize = true; footer.Controls.Add(v); }
        change.Font = new Font("Segoe UI", 8.5F); change.LinkColor = AccentDark; change.AutoSize = true;
        finish.Text = "Stop and save"; finish.Size = new Size(124, 32); Secondary(finish);
        footer.Controls.Add(change); footer.Controls.Add(finish);
        footer.Resize += delegate { LayoutFooter(); };

        content.Dock = DockStyle.Fill; content.BackColor = Color.White;
        // The step is what the eye goes to: the one large thing in the window.
        body.Font = new Font("Segoe UI Semibold", 14F); body.ForeColor = Ink; body.AutoSize = true;
        whereLabel.Font = new Font("Segoe UI", 9.5F); whereLabel.ForeColor = Color.FromArgb(43, 93, 124); whereLabel.AutoSize = true;
        noteLabel.Font = new Font("Segoe UI Semibold", 9.5F); noteLabel.ForeColor = Ink; noteLabel.AutoSize = true;
        note.Font = new Font("Segoe UI", 11F); note.BorderStyle = BorderStyle.FixedSingle;
        // A note is often a sentence or two: it wraps, and the box grows with it
        // (to five lines, then it scrolls). Enter still presses the main button.
        note.Multiline = true; note.WordWrap = true; note.AcceptsReturn = false; note.ScrollBars = ScrollBars.None;
        addNote.Font = new Font("Segoe UI", 9F); addNote.LinkColor = AccentDark; addNote.AutoSize = true; addNote.Text = "+ Add a note";
        signal.Font = new Font("Segoe UI Semibold", 9.5F); signal.TextAlign = ContentAlignment.MiddleLeft; signal.Padding = new Padding(10, 0, 10, 0);
        done.Size = new Size(120, 38); Primary(done);
        skip.Size = new Size(176, 38); Secondary(skip);
        Quiet(skipGroup); skipGroup.AutoSize = true; skipGroup.AutoSizeMode = AutoSizeMode.GrowAndShrink;
        back.Text = "\u2190  Redo previous"; Quiet(back); back.AutoSize = true; back.AutoSizeMode = AutoSizeMode.GrowAndShrink;
        own.Text = "+  Record a setting not listed"; Quiet(own); own.AutoSize = true; own.AutoSizeMode = AutoSizeMode.GrowAndShrink;
        tips.SetToolTip(own, "Changed something no step asks about? Record it now, then carry on where you were.");
        hint.Font = new Font("Segoe UI", 9F); hint.ForeColor = Muted; hint.AutoSize = true;
        foreach (Control c in new Control[] { body, whereLabel, noteLabel, note, addNote, signal, done, skip, skipGroup, back, own, hint }) content.Controls.Add(c);
        // Laid out again whenever the step area changes size: the first step was
        // laid out before its width was known, in a narrow column.
        content.Resize += delegate { Relayout(); };

        // Docked from the last added: the header on top, the bar under it, the footer, then the rest.
        Controls.Add(content); Controls.Add(footer); Controls.Add(progress); Controls.Add(header);
        AcceptButton = done;
        ResumeLayout(false);

        done.Click += delegate { OnDone(); };
        skip.Click += delegate { OnSkip(); };
        skipGroup.Click += delegate { OnSkipGroup(); };
        back.Click += delegate { OnBack(); };
        own.Click += delegate { OnOwn(); };
        finish.Click += delegate { if (Confirm()) { closing = true; Close(); } };
        change.LinkClicked += delegate { Repick(); };
        addNote.LinkClicked += delegate { noteShown = true; Relayout(); note.Focus(); };
        note.TextChanged += delegate {
            if (asking && autoLeft == 0) SetDone(note.Text.Trim().Length > 0);
            if (note.Visible && NoteHeight() != note.Height) Relayout();
        };
        timer.Interval = 500;
        timer.Tick += delegate { OnTick(); };
        Shown += delegate {
            Rectangle wa = Screen.PrimaryScreen.WorkingArea;
            Location = new Point(wa.Right - Width - 12, wa.Bottom - Height - 12);
            timer.Start();
        };
        Load += delegate {
            using (Graphics g = CreateGraphics()) dpiScale = g.DpiX / 96f;
            ShowStep();
        };
        FormClosing += delegate (object sender, FormClosingEventArgs e) {
            if (!closing && !Confirm()) { e.Cancel = true; return; }
            if (atEnd) FinishedAll = true;
            timer.Stop();
        };
    }

    int S(int v) { return (int)Math.Round(v * dpiScale); }

    /** Lays the step out top to bottom, so a long instruction pushes the rest down instead of hiding it. */
    void Relayout() {
        int x = S(22), w = content.ClientSize.Width - 2 * x, y = S(22);
        body.MaximumSize = new Size(w, 0); body.Location = new Point(x, y); y = body.Bottom + S(8);
        whereLabel.Visible = whereLabel.Text.Length > 0;
        if (whereLabel.Visible) { whereLabel.MaximumSize = new Size(w, 0); whereLabel.Location = new Point(x, y); y = whereLabel.Bottom + S(16); }
        else y += S(10);
        bool showNote = !atEnd && (asking || noteShown);
        noteLabel.Visible = showNote; note.Visible = showNote; addNote.Visible = !showNote && !atEnd;
        if (showNote) {
            noteLabel.Location = new Point(x, y); y = noteLabel.Bottom + S(4);
            note.Width = w; note.Height = NoteHeight();
            note.ScrollBars = note.Height >= NoteLines(5) ? ScrollBars.Vertical : ScrollBars.None;
            note.Location = new Point(x, y); y = note.Bottom + S(14);
        }
        else if (!atEnd) { addNote.Location = new Point(x - S(2), y); y = addNote.Bottom + S(12); }
        signal.Visible = !atEnd;
        if (signal.Visible) { signal.Location = new Point(x, y); signal.Size = new Size(w, S(32)); y = signal.Bottom + S(14); }
        // One main button, then the other answer to the step; skipping the rest
        // of a section is a quieter choice, on the right.
        Fit(done, S(120)); Fit(skip, S(150));
        done.Location = new Point(x, y);
        skip.Location = new Point(done.Right + S(10), y);
        int row = done.Bottom;
        if (skipGroup.Visible) {
            int right = skip.Visible ? skip.Right : done.Right;
            int gx = x + w - skipGroup.Width + S(4);
            if (gx >= right + S(12)) skipGroup.Location = new Point(gx, y + (done.Height - skipGroup.Height) / 2);
            else { skipGroup.Location = new Point(x - S(4), done.Bottom + S(6)); row = skipGroup.Bottom; }
        }
        y = row + S(12);
        back.Location = new Point(x - S(4), y);
        own.Location = new Point(x + w - own.Width + S(4), y);
        y = Math.Max(back.Bottom, own.Bottom) + S(8);
        hint.MaximumSize = new Size(w, 0); hint.Location = new Point(x, y);
        // A long step makes the window taller (its bottom edge stays put), so
        // nothing ends up under the footer.
        // Only once the step area has its real width: laid out narrower, the text
        // runs long and would make the window grow for nothing.
        int need = hint.Bottom + S(16) - content.ClientSize.Height;
        if (need > 0 && Visible && content.Width >= ClientSize.Width - 2) {
            Rectangle wa = Screen.FromControl(this).WorkingArea;
            int bottom = Bottom, h = Math.Min(Height + need, wa.Height);
            if (h > Height) { Height = h; Top = Math.Max(wa.Top, bottom - h); }
        }
    }

    /** The footer: a column each, its figure large and what it counts under
     *  it; Stop and save on the right. Taller when a line takes two. */
    void LayoutFooter() {
        int x = S(20), right = footer.ClientSize.Width - S(20), top = S(12);
        Label[][] cols = { new Label[] { recKey, recVal, recSub }, new Label[] { picKey, picVal, picSub } };
        int cw = Math.Min(S(190), (right - finish.Width - S(16) - x) / cols.Length), bottom = 0;
        for (int i = 0; i < cols.Length; i++) {
            Label[] c = cols[i];
            int cx = x + i * cw;
            c[0].Location = new Point(cx, top);
            c[1].Location = new Point(cx - S(2), c[0].Bottom);
            c[2].MaximumSize = new Size(cw - S(12), 0);
            c[2].Location = new Point(cx, c[1].Bottom - S(2));
            int b = c[2].Bottom;
            if (c[1] == picVal && change.Visible) { change.Location = new Point(cx - S(1), b + S(1)); b = change.Bottom; }
            bottom = Math.Max(bottom, b);
        }
        int h = Math.Max(bottom + S(12), finish.Height + S(28));
        if (Math.Abs(footer.Height - h) > S(2)) footer.Height = h;
        finish.Location = new Point(right - finish.Width, (footer.ClientSize.Height - finish.Height) / 2);
    }

    /** The height of n lines of the note box. */
    int NoteLines(int n) { return TextRenderer.MeasureText("Xg", note.Font).Height * n + S(8); }

    /** The note box's height for what is in it: one line to five. */
    int NoteHeight() {
        int w = Math.Max(S(100), note.Width - S(10));
        int text = TextRenderer.MeasureText(note.Text.Length > 0 ? note.Text : "X", note.Font, new Size(w, int.MaxValue),
            TextFormatFlags.WordBreak | TextFormatFlags.TextBoxControl).Height;
        return Math.Max(NoteLines(1), Math.Min(NoteLines(5), text + S(8)));
    }

    /** A button as wide as its words need. */
    void Fit(Button b, int min) { b.Width = Math.Max(min, TextRenderer.MeasureText(b.Text, b.Font).Width + S(34)); }

    void SetDone(bool on) {
        done.Enabled = on;
        if (doneIsPrimary) done.BackColor = on ? AccentDark : Off;
        else { done.BackColor = Color.White; done.ForeColor = on ? Ink : Off; }
    }

    /** Which of Done and the second button is the main one, the one Enter presses. */
    void SetMain(bool doneMain) {
        doneIsPrimary = doneMain;
        if (doneMain) { Primary(done); Secondary(skip); AcceptButton = done; }
        else { Primary(skip); Secondary(done); AcceptButton = skip; }
        SetDone(done.Enabled);
    }

    void SetSignal(Color back, Color fore, string text) { signal.BackColor = back; signal.ForeColor = fore; signal.Text = text; }

    static void Primary(Button b) {
        b.FlatStyle = FlatStyle.Flat; b.FlatAppearance.BorderSize = 0; b.UseVisualStyleBackColor = false;
        b.BackColor = AccentDark; b.ForeColor = Color.White; b.Font = new Font("Segoe UI Semibold", 10F); b.Cursor = Cursors.Hand;
    }

    static void Secondary(Button b) {
        b.FlatStyle = FlatStyle.Flat; b.FlatAppearance.BorderSize = 1; b.FlatAppearance.BorderColor = Line; b.UseVisualStyleBackColor = false;
        b.BackColor = Color.White; b.ForeColor = Ink; b.Font = new Font("Segoe UI", 10F); b.Cursor = Cursors.Hand;
    }

    static void Quiet(Button b) {
        b.FlatStyle = FlatStyle.Flat; b.FlatAppearance.BorderSize = 0; b.FlatAppearance.MouseOverBackColor = Paper; b.UseVisualStyleBackColor = false;
        b.BackColor = Color.White; b.ForeColor = AccentDark; b.TextAlign = ContentAlignment.MiddleLeft; b.Font = new Font("Segoe UI", 9F); b.Cursor = Cursors.Hand;
    }

    static bool Has(SdStep s, string flag) { return (" " + (s.Flags ?? "").Replace(",", " ") + " ").Contains(" " + flag + " "); }
    static string Iso(DateTime t) { return t.ToString("yyyy-MM-ddTHH:mm:ss.fff", CultureInfo.InvariantCulture) + "Z"; }

    /** For the preview and the tests: the step on screen now. */
    public string CurrentStepId { get { return index < steps.Count ? steps[index].Id : ""; } }

    void ShowStep() {
        atEnd = false; skip.Visible = true; finish.Visible = true;
        if (index >= steps.Count) { ShowEnd(); return; }
        SdStep s = steps[index];
        bool mine = IsOwn(s);
        // Tries already recorded: a step done again after Redo previous is try 2.
        int tries = 0;
        foreach (SdStepResult r in Results) if (r.Id == s.Id && r.Status == "done") tries++;
        attempt = tries; stepStart = DateTime.UtcNow; note.Text = "";
        stepSent = SentAll; stepReceived = ReceivedAll;
        SetSignal(Color.White, Muted, "");
        bool rep = Has(s, "repeat");
        title.Text = "Recording the " + DeviceName;
        // Where the step stands in its section, which is what "skip" skips.
        int first = index, last = index;
        while (first > 0 && steps[first - 1].Group == s.Group) first--;
        while (last + 1 < steps.Count && steps[last + 1].Group == s.Group) last++;
        int inGroup = last - first + 1, left = last - index + 1;
        groupLabel.Text = (s.Group + (inGroup > 1 ? "   \u00b7   " + (index - first + 1) + " of " + inGroup : "")).ToUpperInvariant();
        stepLabel.Text = "Step " + (index + 1) + " of " + steps.Count;
        skipGroup.Text = (left == inGroup ? "Skip all " + inGroup + " " + s.Group + " steps" : "Skip the rest of " + s.Group + " (" + left + " steps)") + "  \u2192";
        skipGroup.Visible = left > 1 && !mine && s.Group != "Start" && s.Group != "Finish";
        own.Visible = !mine;
        progressFraction = Math.Min(1.0, (double)index / Math.Max(1, steps.Count));
        progress.Invalidate();
        // An ask step's own label says it: the instruction need not.
        body.Text = Has(s, "ask") ? s.Text.Replace(" Type the value it shows now.", "") : s.Text;
        string w;
        whereLabel.Text = Where.TryGetValue(s.Group, out w) ? "Where to find it: " + w : "";
        // Shown again by Redo previous after a change: what the first try set is
        // still on the device, so it is put back before the step is done again.
        puttingBack = redoing && tries > 0 && !rep && Changes(s);
        redoing = false;
        hint.Text = mine
            ? "Do it in the official software, write in the note what you changed, then click Done. Never mind takes you back to the step you were on."
            : rep
            ? "Type the name of each one in the note and click Save this one. After the last one (or if there is none), click That was the last one."
            : puttingBack
                ? "Doing this step again. If the first try worked, just click Done. If not, first put it back the way it was before this step and click I put it back; then do the step again and click Done."
                : tries > 0
                    ? "Doing this step again (try " + (tries + 1) + "). The first try is kept: if it worked, just click Done."
                    : Has(s, "ask")
                        ? "Do only this in the official software, then type the value it shows and click Done. Not there? Click Not in my software."
                        : "Do only this in the official software, wait a second, then click Done. Not there? Click Not in my software.";
        done.Text = rep ? "Save this one" : "Done";
        skip.Text = mine ? "Never mind" : rep ? "That was the last one" : puttingBack ? "I put it back" : "Not in my software";
        back.Enabled = index > 0 && !mine;
        autoLeft = Has(s, "auto15") ? 15 : 0;
        asking = Has(s, "ask") || rep;
        noteShown = false;
        noteLabel.Text = mine ? "Which setting, and what you set it to:"
            : Has(s, "describe") ? "What you did, and what you expected:"
            : rep ? "Its name, and the value you set if any:" : "Type the value it shows now:";
        // Putting the first try back comes first: its button is the one that stands out.
        SetMain(!puttingBack);
        SetDone(autoLeft == 0 && !asking);
        skip.Enabled = autoLeft == 0;
        if (autoLeft > 0) body.Text = s.Text + "\n" + autoLeft + " s";
        if (Has(s, "attach") && !Preview) {
            try { Directory.CreateDirectory(attachDir); Process.Start("explorer.exe", "\"" + attachDir + "\""); } catch (Exception) { }
        }
        Relayout();
        if (asking) note.Focus(); else if (puttingBack) skip.Focus(); else if (done.Enabled) done.Focus();
        UpdateStatus();
    }

    SdStepResult Record(SdStep s, string state, DateTime start) {
        SdStepResult r = new SdStepResult();
        r.Id = s.Id; r.Group = s.Group; r.Value = s.Value; r.Series = s.Series; r.Text = s.Text;
        r.Status = state; r.Note = note.Text.Trim(); r.Attempt = attempt;
        r.Start = Iso(start); r.End = Iso(DateTime.UtcNow);
        if (state == "done" && !Preview) r.Shots = Shoot(s, attempt);
        if (state == "done" && Has(s, "auto15") && !Preview) {
            idleRate = (SentAll - stepSent) / Math.Max(1.0, (DateTime.UtcNow - start).TotalSeconds);
        }
        Results.Add(r);
        return r;
    }

    public void OnDone() {
        if (atEnd) { FinishedAll = true; closing = true; Close(); return; }
        if (index >= steps.Count) return;
        SdStep s = steps[index];
        // The value the owner really set: Done waits for it (a script driving the preview does not).
        if (asking && note.Text.Trim().Length == 0 && !Preview) { note.Focus(); return; }
        // A change that never reached the device: the software waits for Apply or
        // Save, or the step was not done. Asked once, so nothing passes unseen.
        if (!Preview && Changes(s) && SentAll - stepSent == 0 && !puttingBack) {
            DialogResult go = MessageBox.Show(this,
                "Nothing reached the " + DeviceName + " in this step yet.\n\n" +
                "Some software sends a change only on Apply or Save. Not in your software? Click No, then Not in my software.\n\n" +
                "Done anyway?",
                Text, MessageBoxButtons.YesNo, MessageBoxIcon.Question);
            if (go != DialogResult.Yes) return;
        }
        if (Has(s, "window") && softwarePid == 0 && !Preview) {
            if (candidatePid != 0) {
                if (!ConfirmCandidate()) {
                    MessageBox.Show(this, "Click once on the official software's window, then on Done again.", Text, MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return;
                }
            } else {
                DialogResult go = MessageBox.Show(this,
                    "No window of the official software was seen yet: click once on it, then on Done again.\n\nGo on without pictures of it?",
                    Text, MessageBoxButtons.YesNo, MessageBoxIcon.Question);
                if (go != DialogResult.Yes) return;
                picking = false;
            }
        }
        Record(s, "done", stepStart);
        if (Has(s, "repeat")) {
            attempt++; stepStart = DateTime.UtcNow; note.Text = "";
            stepSent = SentAll; stepReceived = ReceivedAll;
            stepLabel.Text = "Step " + (index + 1) + " of " + steps.Count + "  \u00b7  " + attempt + " saved";
            SetDone(false); note.Focus();
            return;
        }
        index++; ShowStep();
    }

    public void OnSkip() {
        if (index >= steps.Count) return;
        SdStep s = steps[index];
        // An own setting the owner thought better of: gone, as if never asked.
        if (IsOwn(s)) { steps.RemoveAt(index); ShowStep(); return; }
        if (puttingBack) {
            // What putting it back sent is kept apart from the step done again.
            Record(s, "reverted", stepStart);
            puttingBack = false;
            stepStart = DateTime.UtcNow; stepSent = SentAll; stepReceived = ReceivedAll;
            hint.Text = "Now do the step again, then click Done.";
            skip.Text = "Not in my software";
            SetMain(true);
            Relayout();
            if (done.Enabled) done.Focus();
            UpdateStatus();
            return;
        }
        if (!(Has(s, "repeat") && attempt > 0)) Record(s, "not-offered", stepStart);
        index++; ShowStep();
    }

    public void OnSkipGroup() {
        if (index >= steps.Count) return;
        string g = steps[index].Group;
        while (index < steps.Count && steps[index].Group == g) { Record(steps[index], "skipped", stepStart); index++; }
        ShowStep();
    }

    /** Redo the previous step. Its first try stays in the recording, and so does
     *  what the step being left saw so far (as "left"). */
    void OnBack() {
        if (index == 0) return;
        if (index < steps.Count && (DateTime.UtcNow - stepStart).TotalSeconds >= 2) Record(steps[index], "left", stepStart);
        index--;
        redoing = true;
        ShowStep();
    }

    static bool IsOwn(SdStep s) { return s.Id.StartsWith("own.", StringComparison.Ordinal); }

    /** The end of a recording, in a window of its own (the console is easy to
     *  miss behind the folder that opens): what is in it, and where it goes.
     *  "new", "existing", or "" for not now. */
    public static string AskToSend(string zipName, string deviceName, bool keyboard) {
        string answer = "";
        using (Form f = new Form()) {
            f.AutoScaleDimensions = new SizeF(96F, 96F); f.AutoScaleMode = AutoScaleMode.Dpi;
            f.Text = "Shark Deck - recording saved"; f.Font = new Font("Segoe UI", 10F); f.BackColor = Color.White;
            f.FormBorderStyle = FormBorderStyle.FixedDialog; f.MinimizeBox = false; f.MaximizeBox = false;
            f.ShowInTaskbar = true; f.TopMost = true; f.StartPosition = FormStartPosition.CenterScreen;
            f.ClientSize = new Size(560, 316);
            Panel head = new Panel(); head.Dock = DockStyle.Top; head.Height = 64; head.BackColor = Night;
            Label t = new Label(); t.Text = "Recording saved"; t.Font = new Font("Segoe UI Semibold", 13F);
            t.ForeColor = Color.White; t.AutoSize = true; t.Location = new Point(20, 9);
            Label name = new Label(); name.Text = zipName; name.Font = new Font("Segoe UI", 9F);
            name.ForeColor = Color.FromArgb(111, 211, 224); name.AutoSize = true; name.Location = new Point(21, 38);
            head.Controls.Add(t); head.Controls.Add(name);
            Label q = new Label();
            q.Text = "Send it to Shark Deck: attach the .zip to an issue on GitHub, so the " + deviceName + " can be supported.";
            q.Font = new Font("Segoe UI Semibold", 12.5F); q.ForeColor = Ink; q.AutoSize = true;
            Label pics = new Label();
            // What was typed on a keyboard while it recorded was wiped as it came
            // in (SdPcap): said here, where the owner decides to share the file.
            pics.Text = "The folder that just opened holds the .zip and the same files unpacked: capture.pcap is the USB traffic"
                + (keyboard ? ", without what you typed on the " + deviceName : "")
                + ", report.txt describes the device and \"screens\" holds the pictures. "
                + "Delete any picture you would rather not share first: the .zip is packed again when you choose.";
            pics.Font = new Font("Segoe UI", 9F); pics.ForeColor = Muted; pics.AutoSize = true;
            Button create = new Button(); create.Text = "Open a new issue"; Primary(create); create.Size = new Size(176, 38);
            Button add = new Button(); add.Text = "Add it to an issue already open"; Secondary(add); add.Size = new Size(250, 38);
            Button later = new Button(); later.Text = "Not now"; Quiet(later); later.AutoSize = true;
            // Laid out once the window has its scale, top to bottom, as the step window is.
            f.Load += delegate {
                float k; using (Graphics g = f.CreateGraphics()) k = g.DpiX / 96f;
                int x = (int)Math.Round(20 * k), w = f.ClientSize.Width - 2 * x;
                q.MaximumSize = new Size(w, 0); pics.MaximumSize = new Size(w, 0);
                q.Location = new Point(x, head.Bottom + (int)Math.Round(20 * k));
                pics.Location = new Point(x, q.Bottom + (int)Math.Round(10 * k));
                create.Location = new Point(x, pics.Bottom + (int)Math.Round(20 * k));
                add.Location = new Point(create.Right + (int)Math.Round(10 * k), create.Top);
                later.Location = new Point(x - (int)Math.Round(4 * k), create.Bottom + (int)Math.Round(8 * k));
                f.ClientSize = new Size(f.ClientSize.Width, later.Bottom + (int)Math.Round(14 * k));
            };
            create.Click += delegate { answer = "new"; f.Close(); };
            add.Click += delegate { answer = "existing"; f.Close(); };
            later.Click += delegate { f.Close(); };
            f.Controls.Add(q); f.Controls.Add(pics); f.Controls.Add(create); f.Controls.Add(add); f.Controls.Add(later); f.Controls.Add(head);
            f.AcceptButton = create;
            f.Shown += delegate { f.Activate(); create.Focus(); };
            f.ShowDialog();
        }
        return answer;
    }

    /** "Record a setting not listed": a step of the owner's own, now, then back
     *  to the step they were on. Its note says what they changed. */
    public void OnOwn() {
        if (index < steps.Count && IsOwn(steps[index])) return;
        if (index < steps.Count && (DateTime.UtcNow - stepStart).TotalSeconds >= 2) Record(steps[index], "left", stepStart);
        SdStep o = new SdStep();
        o.Id = "own." + (++ownCount); o.Kind = "both"; o.Group = "Your own setting"; o.Value = ""; o.Series = ""; o.Flags = "ask,describe";
        o.Text = "Change one setting in the official software that no step asked about, the way you would use it.";
        steps.Insert(index, o);
        ShowStep();
    }

    /** After the last step: saving is the one thing left, and the main button. */
    void ShowEnd() {
        atEnd = true;
        title.Text = "Recording the " + DeviceName;
        groupLabel.Text = "ALL " + steps.Count + " STEPS DONE";
        stepLabel.Text = "";
        progressFraction = 1.0; progress.Invalidate();
        body.Text = "That was the last step. Save the recording.";
        whereLabel.Text = "";
        hint.Text = "Changed a setting no step asked about? Record it first (Record a setting not listed), then save.";
        asking = false; noteShown = false; puttingBack = false; autoLeft = 0;
        done.Text = "Save the recording"; SetMain(true); SetDone(true);
        skip.Visible = false; skipGroup.Visible = false; own.Visible = true; finish.Visible = false;
        back.Enabled = steps.Count > 0;
        SetSignal(Color.White, Muted, "");
        Relayout();
        done.Focus();
        UpdateStatus();
    }

    bool Confirm() {
        if (index >= steps.Count) return true;
        string text = "Stop here and save what was recorded so far?";
        List<string> still = StillChanged();
        if (still.Count > 0)
            text += "\n\nStill changed on your device (put it back in the official software afterwards):\n- " + string.Join("\n- ", still.ToArray());
        return MessageBox.Show(this, text, Text, MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes;
    }

    /** Whether a step changes something on the device that may need putting back. */
    static bool Changes(SdStep s) {
        return s.Group != "Start" && s.Group != "Finish" && s.Group != "Anything else"
            && !Has(s, "auto15") && !Has(s, "nochange") && !Has(s, "window") && !Has(s, "attach") && !Has(s, "detect");
    }

    /** What the steps done changed and no later step of their group put back,
     *  as "group: value": what to put back by hand when the owner stops early. */
    public List<string> StillChanged() {
        Dictionary<string, string> pending = new Dictionary<string, string>();
        List<string> order = new List<string>();
        foreach (SdStepResult r in Results) {
            if (r.Status != "done") continue;
            SdStep s = null;
            foreach (SdStep x in steps) if (x.Id == r.Id) { s = x; break; }
            if (s == null || !Changes(s)) continue;
            if (Has(s, "undo")) { pending.Remove(s.Group); continue; }
            if (!order.Contains(s.Group)) order.Add(s.Group);
            pending[s.Group] = s.Value.Length > 0 ? s.Value : "changed";
        }
        List<string> list = new List<string>();
        foreach (string g in order) if (pending.ContainsKey(g)) list.Add(g + ": " + pending[g]);
        return list;
    }

    void OnTick() {
        ticks++;
        if (!Preview && picking) Pick();
        if (autoLeft > 0 && ticks % 2 == 0 && index < steps.Count) {
            autoLeft--;
            SdStep s = steps[index];
            if (autoLeft > 0) body.Text = s.Text + "\n" + autoLeft + " s";
            else { Record(s, "done", stepStart); index++; ShowStep(); }
        }
        if (!Preview && ticks % 4 == 0) WatchDevices();
        if (ticks % 2 == 0) UpdateStatus();
    }

    /** The official software, as a candidate: the last other program brought to
     *  the front. It is pictured only once the owner says it is the one. */
    void Pick() {
        IntPtr fg = GetForegroundWindow();
        if (fg == IntPtr.Zero || fg == Handle) return;
        uint pid; GetWindowThreadProcessId(fg, out pid);
        if (pid == 0 || pid == (uint)ownPid) return;
        try {
            string name = Process.GetProcessById((int)pid).ProcessName;
            if (Array.IndexOf(NotTheSoftware, name.ToLowerInvariant()) >= 0) return;
            StringBuilder title = new StringBuilder(256); GetWindowText(fg, title, 256);
            if (pid == candidatePid && title.ToString() == candidateTitle) return;
            candidatePid = pid; candidateName = name; candidateTitle = title.ToString();
            UpdateStatus();
        } catch (Exception) { }
    }

    /** Whether the window last clicked is the official software: asked with a
     *  picture of it, and only then pictured at each step. */
    bool ConfirmCandidate() {
        if (!AskIsSoftware(candidatePid, candidateName, candidateTitle)) { candidatePid = 0; return false; }
        softwarePid = candidatePid; SoftwareName = candidateName; SoftwareTitle = candidateTitle;
        SoftwarePath = ImagePath(candidatePid); picking = false;
        UpdateStatus();
        return true;
    }

    /** The question, with the picture that would be taken: a window's name says
     *  little. The picture is only shown here, never saved. */
    bool AskIsSoftware(uint pid, string name, string windowTitle) {
        Bitmap shot = null;
        try { shot = SdShot.Snapshot(pid); } catch (Exception) { }
        using (Form f = new Form()) {
            f.AutoScaleDimensions = new SizeF(96F, 96F); f.AutoScaleMode = AutoScaleMode.Dpi;
            f.Text = Text; f.Font = Font; f.BackColor = Color.White;
            f.FormBorderStyle = FormBorderStyle.FixedDialog; f.MinimizeBox = false; f.MaximizeBox = false;
            f.ShowInTaskbar = false; f.TopMost = true; f.StartPosition = FormStartPosition.CenterScreen;
            f.ClientSize = new Size(560, 480);
            Label q = new Label(); q.Text = "Is this the official software for your " + DeviceName + "?";
            q.Font = new Font("Segoe UI Semibold", 12F); q.ForeColor = Ink; q.AutoSize = true; q.Location = new Point(20, 16);
            PictureBox pic = new PictureBox(); pic.Location = new Point(20, 52); pic.Size = new Size(520, 300);
            pic.SizeMode = PictureBoxSizeMode.Zoom; pic.BackColor = Paper; pic.Image = shot;
            Label who = new Label();
            who.Text = windowTitle.Length == 0 ? name + "   \u00b7   a window without a title"
                : windowTitle == name ? name : windowTitle + "   \u00b7   " + name;
            who.ForeColor = Muted; who.AutoEllipsis = true; who.Size = new Size(520, 20); who.Location = new Point(20, 360);
            Label what = new Label(); what.Text = "If it is, a picture of this window is taken at each step, and of nothing else.";
            what.ForeColor = Ink; what.Size = new Size(520, 22); what.Location = new Point(20, 384);
            Button yes = new Button(); yes.Text = "Yes, it is"; Primary(yes); yes.Size = new Size(130, 36); yes.Location = new Point(20, 424);
            yes.DialogResult = DialogResult.Yes;
            Button no = new Button(); no.Text = "No, I will click another"; Secondary(no); no.Size = new Size(200, 36); no.Location = new Point(160, 424);
            no.DialogResult = DialogResult.No;
            f.Controls.AddRange(new Control[] { q, pic, who, what, yes, no });
            f.AcceptButton = yes; f.CancelButton = no;
            try { return f.ShowDialog(this) == DialogResult.Yes; } finally { if (shot != null) shot.Dispose(); }
        }
    }

    /** Pictures of another window: the owner clicks on it, sees it, and says it
     *  is the one. Until then the pictures go on as they were. */
    void Repick() {
        candidatePid = 0; picking = true;
        UpdateStatus();
        MessageBox.Show(this, "Click once on the official software's window, then click OK here.", Text, MessageBoxButtons.OK, MessageBoxIcon.Information);
        if (candidatePid != 0 && candidatePid != softwarePid) ConfirmCandidate();
        candidatePid = 0;
        picking = softwarePid == 0 && index < steps.Count && Has(steps[index], "window");
        UpdateStatus();
    }

    static string ImagePath(uint pid) {
        IntPtr h = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
        if (h == IntPtr.Zero) return "";
        try {
            StringBuilder sb = new StringBuilder(1024); int n = sb.Capacity;
            return QueryFullProcessImageName(h, 0, sb, ref n) ? sb.ToString() : "";
        } finally { CloseHandle(h); }
    }

    /** A receiver plugged in during the recording joins it. */
    void WatchDevices() {
        List<string> now;
        try { now = SdHid.Paths(); } catch (Exception) { return; }
        foreach (string p in now) {
            if (seenPaths.Contains(p)) continue;
            seenPaths.Add(p);
            SdHidInterface i;
            try { i = SdHid.Describe(p); } catch (Exception) { continue; }
            if (i.Vid == 0) continue;
            bool detecting = index < steps.Count && Has(steps[index], "detect");
            if (vids.Contains(i.Vid) || detecting) {
                NewInterfaces.Add(i);
                vids.Add(i.Vid);
                lastNew = i.Vid.ToString("X4") + ":" + i.Pid.ToString("X4");
            }
        }
    }

    /** What is being recorded, as it is: so the owner knows a step reached the
     *  device, and what is not recorded at all. */
    void UpdateStatus() {
        long sent = SentAll - stepSent;
        recVal.Text = Preview ? "Preview" : SentAll.ToString("N0", CultureInfo.InvariantCulture);
        recSub.Text = Preview ? "nothing is recorded"
            : (SentAll == 1 ? "message" : "messages") + " to the " + DeviceName
              + (lastNew != null ? "\nand " + lastNew + ", just plugged in" : "");
        bool windowStep = index < steps.Count && Has(steps[index], "window");
        if (softwarePid != 0) {
            picVal.Text = shotCount.ToString(CultureInfo.InvariantCulture);
            picSub.Text = "of " + SoftwareName;
            change.Text = "Wrong window?"; change.Visible = true;
        } else if (picking) {
            picVal.Text = "\u2014";
            picSub.Text = candidatePid != 0 && windowStep
                ? candidateName + "? Done shows its picture first."
                : "click once on the official software";
            change.Visible = false;
        } else {
            picVal.Text = "None";
            picSub.Text = "no window is pictured";
            change.Text = "Pick a window"; change.Visible = !Preview;
        }
        tips.SetToolTip(recSub, Preview ? "" : "Only the " + DeviceName + "'s own USB messages are recorded: nothing from any other device.");
        tips.SetToolTip(picSub, softwarePid != 0 ? "Only the official software's window is pictured, once a step is done: nothing else on the screen." : "");
        LayoutFooter();
        if (Preview) return;
        // Whether the step reached the device: more than the software sends on its own.
        if (index < steps.Count && Changes(steps[index])) {
            double secs = (DateTime.UtcNow - stepStart).TotalSeconds;
            double expected = idleRate * secs;
            if (sent >= 1 && sent >= expected + (idleRate > 0 ? 2 : 1))
                SetSignal(Color.FromArgb(231, 245, 236), Color.FromArgb(30, 123, 52),
                    "\u2714  The " + DeviceName + " received it (" + sent + " message" + (sent == 1 ? "" : "s") + "). Once the software shows it, click " + done.Text + ".");
            else if (secs > 8)
                SetSignal(Color.FromArgb(255, 244, 229), Color.FromArgb(154, 91, 0),
                    "Nothing reached the " + DeviceName + " yet: some software sends a change only on Apply or Save.");
            else
                SetSignal(Color.FromArgb(241, 243, 245), Muted, "Waiting for the software to send this to the " + DeviceName + "...");
        } else SetSignal(Color.White, Muted, "");
    }

    List<string> Shoot(SdStep s, int attemptNo) {
        List<string> files = new List<string>();
        if (softwarePid == 0) return files;
        StringBuilder stem = new StringBuilder((Results.Count + 1).ToString("D3") + "-");
        foreach (char c in s.Id) stem.Append(char.IsLetterOrDigit(c) || c == '.' || c == '-' ? c : '_');
        if (Has(s, "repeat")) stem.Append("-" + (attemptNo + 1));
        try {
            foreach (string f in SdShot.Capture(softwarePid, shotsDir, stem.ToString(), lastShot)) {
                files.Add("screens/" + Path.GetFileName(f));
                shotCount++;
            }
        } catch (Exception) { }
        return files;
    }
}
'@

# ---- Helpers -------------------------------------------------------------------
function Hex4([int]$n) { '{0:X4}' -f $n }
function HexBytes([byte[]]$b) { if ($null -eq $b) { return $null }; ($b | ForEach-Object { '{0:x2}' -f $_ }) -join '' }
function BytesOf([string]$hex) { [byte[]]@(for ($i = 0; $i -lt $hex.Length; $i += 2) { [Convert]::ToByte($hex.Substring($i, 2), 16) }) }

function Say([string]$text, [string]$color = 'Gray') { Write-Host $text -ForegroundColor $color }

function UsageName([int]$page, [int]$usage) {
    if ($page -eq 1 -and $usage -eq 2) { return 'mouse' }
    if ($page -eq 1 -and $usage -eq 6) { return 'keyboard' }
    if ($page -eq 1 -and $usage -eq 0x80) { return 'system controls' }
    if ($page -eq 0x0C) { return 'media keys' }
    if ($page -ge 0xFF00) { return 'vendor (settings)' }
    return 'other'
}

function FamilyOf([int]$vid) {
    if ($RoyuanVendorIds -contains $vid) { return 'royuan' }
    if ($vid -eq $HubVendorId) { return 'compx-hub' }
    if ($vid -eq $JxcVendorId) { return 'jxc' }
    if ($vid -eq $BekenVendorId) { return 'beken' }
    return 'unknown'
}

function FamilyText([string]$family) {
    switch ($family) {
        'royuan' { 'ROYUAN chip (Attack Shark keyboards, GearHub mice) - Shark Deck knows this family' }
        'compx-hub' { 'Compx MOUSE HUB (the V8 and its successors) - Shark Deck knows this family' }
        'jxc' { 'JXC chip (R5 ULTRA, R6, R8) - Shark Deck knows this family' }
        'beken' { 'Beken chip (the X8 PRO, the original X11 and others) - Shark Deck configures the X8 PRO (receiver and cable) and the X11 (cable), and shows the others' }
        default { 'a family Shark Deck does not know yet' }
    }
}

# Parses "--device 1D57:FA55 --no-query --out C:\x" from the .bat's arguments.
function ReadFlags([string]$line) {
    $flags = @{ Device = $null; AllKnown = $false; NoQuery = $false; Out = $null; Record = $false; NoRecord = $false; Steps = $null; Kind = $null; RecordingOf = $null; SetupOf = $null; Preview = $null; Resume = $false }
    $words = @(if ($line) { $line.Trim() -split '\s+' })
    for ($i = 0; $i -lt $words.Count; $i++) {
        switch ($words[$i].ToLowerInvariant()) {
            '--device' { $i++; $flags.Device = $words[$i] }
            '--all-known' { $flags.AllKnown = $true }
            '--no-query' { $flags.NoQuery = $true }
            '--out' { $i++; $flags.Out = $words[$i].Trim('"') }
            '--record' { $flags.Record = $true }
            '--no-record' { $flags.NoRecord = $true }
            '--steps' {
                $i++
                $flags.Steps = if ($i -lt $words.Count) { $words[$i].ToLowerInvariant() } else { '' }
                if ($flags.Steps -notmatch '^[a-z]+(,[a-z]+)*$') { throw '--steps takes words, like deep,macro,specific' }
            }
            '--kind' {
                $i++
                $flags.Kind = if ($i -lt $words.Count) { $words[$i].ToLowerInvariant() } else { '' }
                if ($flags.Kind -notin @('mouse', 'keyboard')) { throw '--kind takes mouse or keyboard' }
            }
            '--recording-of' { $i++; $flags.RecordingOf = $words[$i] }
            '--usbpcap-setup' { $i++; $flags.SetupOf = $words[$i] }
            '--resume-recording' { $flags.Resume = $true }
            '--preview-steps' { $i++; $flags.Preview = if ($i -lt $words.Count) { $words[$i].ToLowerInvariant() } else { 'mouse' } }
            '' { }
            default { throw "Unknown option: $($words[$i])" }
        }
    }
    $flags
}

# What the device is, from how it is connected. A family that makes mice only
# (the Hub, JXC and Beken chips) says so; a ROYUAN board's first USB interface
# is its keyboard. Not any device's: the X11, a mouse, has its keyboard
# collection (for macros) on interface 0. Empty when this does not tell.
function KindOf($devices) {
    $families = @(@($devices) | ForEach-Object { $_.family } | Select-Object -Unique)
    if ($families.Count -ne 1) { return '' }
    if ($families[0] -in @('compx-hub', 'jxc', 'beken')) { return 'mouse' }
    if ($families[0] -eq 'royuan') { return FirstInterfaceKind $devices }
    return ''
}

# The kind of the collection on a device's first USB interface: a guess for a
# device of no known family, offered as the default answer.
function FirstInterfaceKind($devices) {
    $first = @(@($devices) | ForEach-Object { @($_.interfaces) } | Where-Object { $_.interface -eq 0 -and ($_.kind -eq 'keyboard' -or $_.kind -eq 'mouse') } | ForEach-Object { $_.kind } | Select-Object -Unique)
    if ($first.Count -eq 1) { return $first[0] }
    return ''
}

# The model question, for the families that have one, and only those.
function AskModel([string]$family, [int]$productId, [object[]]$interfaces) {
    $result = [ordered]@{ asked = $false }
    switch ($family) {
        'royuan' {
            if ($RoyuanRelayPids -contains $productId) {
                $result.why = 'This is a receiver that passes questions on to its device; connect the device by cable and run the report again to get its model number.'
                return $result
            }
            $target = @($interfaces | Where-Object { $_.UsagePage -eq $RoyuanUsagePage -and $_.Usage -eq $RoyuanUsage })
            if ($target.Count -eq 0) { $result.why = 'Its settings interface (usage page FFFF, usage 2) is not there.'; return $result }
            if ($target[0].FeatureBytes -ne $RoyuanReportBytes) { $result.why = "Its settings interface has $($target[0].FeatureBytes)-byte reports, not $RoyuanReportBytes; not asked."; return $result }
            $query = BytesOf $RoyuanIdentifyHex
            $result.asked = $true
            $result.command = '0x8F'
            $result.query = $RoyuanIdentifyHex
            $reply = [SdHid]::AskFeature($target[0].Path, $query)
            $result.reply = HexBytes $reply
            if ($null -ne $reply) {
                $result.modelId = [int]$reply[2] + 256 * [int]$reply[3]
                $result.firmware = '{0:x}.{1:x2}' -f $reply[9], $reply[8]
            }
            return $result
        }
        'compx-hub' {
            $target = @($interfaces | Where-Object { $_.UsagePage -eq $HubUsagePage -and $_.Usage -eq $HubUsage })
            if ($target.Count -eq 0) { $result.why = 'Its settings interface (usage page FF02, usage 2) is not there.'; return $result }
            if ($target[0].OutputBytes -ne $HubReportBytes) { $result.why = "Its settings interface has $($target[0].OutputBytes)-byte reports, not $HubReportBytes; not asked."; return $result }
            $query = BytesOf $HubIdentifyHex
            $result.asked = $true
            $result.command = '0x01'
            $result.query = $HubIdentifyHex
            $reply = $null
            for ($try = 0; $try -lt 2 -and $null -eq $reply; $try++) {
                $reply = [SdHid]::AskOutput($target[0].Path, $query, $target[0].InputBytes, 1500)
            }
            $result.reply = HexBytes $reply
            if ($null -ne $reply) {
                $result.cid = [int]$reply[10]
                $result.mid = [int]$reply[11]
                $result.link = [int]$reply[12]
            } else {
                $result.why = 'No answer: is the mouse switched on and awake? Move it, then run the report again.'
            }
            return $result
        }
        'jxc' { $result.why = 'Not needed: on this chip the USB product id names the model.'; return $result }
        'beken' { $result.why = 'Not asked: this tool sends nothing to Beken mice - on some of them a wrong command starts the bootloader.'; return $result }
        default { $result.why = 'Not asked: Shark Deck sends nothing to a device of a family it does not know.'; return $result }
    }
}

# Waits until new HID interfaces appear and settle: the device's own. With
# -Unplug, first says to unplug it (or notices it already is).
function WaitForDevice([switch]$Unplug, [int]$Minutes = 3) {
    if ($Unplug) {
        Say ''
        Say '  1. Unplug the device (or its USB receiver), wait two seconds,' White
        Say '  2. then plug it back in.' White
        Say '     (Already unplugged? Just plug it in.)' DarkGray
        Say ''
        Say '  Waiting for it... (this window carries on by itself; Ctrl+C to stop)' DarkGray
    }
    $base = @([SdHid]::Paths())
    $deadline = (Get-Date).AddMinutes($Minutes)
    $sawUnplug = $false
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 400
        $now = @([SdHid]::Paths())
        $added = @($now | Where-Object { $base -notcontains $_ })
        $removed = @($base | Where-Object { $now -notcontains $_ })
        if ($removed.Count -gt 0 -and $added.Count -eq 0) {
            if ($Unplug -and -not $sawUnplug) { Say '  Unplugged. Now plug it back in.' Cyan }
            $sawUnplug = $true
            $base = $now
            continue
        }
        if ($added.Count -gt 0) {
            # A composite device brings its interfaces up over a moment: wait
            # until two looks in a row agree.
            $last = $now
            for ($i = 0; $i -lt 12; $i++) {
                Start-Sleep -Milliseconds 500
                $again = @([SdHid]::Paths())
                if (@(Compare-Object $again $last).Count -eq 0) { break }
                $last = $again
            }
            Say '  Found it.' Cyan
            return @($last | Where-Object { $base -notcontains $_ })
        }
    }
    return @()
}

# The devices of a family Shark Deck knows that are plugged in now, one entry
# per USB id, with their interfaces.
function KnownDevicesPresent {
    $all = @([SdHid]::Paths() | ForEach-Object { [SdHid]::Describe($_) } | Where-Object { $KnownVendorIds -contains $_.Vid })
    @($all | Group-Object { '{0:X4}:{1:X4}' -f $_.Vid, $_.Pid } | ForEach-Object {
        $named = @($_.Group | Where-Object { $_.Product }) + @($_.Group)
        [pscustomobject]@{ Id = $_.Name; Product = $named[0].Product; Paths = @($_.Group | ForEach-Object { $_.Path }) }
    })
}

# The device to report on. One of a family Shark Deck knows is picked from
# what is plugged in, so nothing is unplugged: a keyboard can take a while to
# type normally again after it is plugged back in. Any other device is found
# by unplugging it and plugging it back in.
function ChooseDevice {
    $known = @(KnownDevicesPresent)
    if ($known.Count -eq 1) {
        $d = $known[0]
        Say ''
        $a = Read-Host ("  Found: $(if ($d.Product) { $d.Product } else { 'a device' }) ($($d.Id)). Is this the device? [Y/n]")
        if ($a -notmatch '^\s*[nN]') { return [pscustomobject]@{ Paths = $d.Paths; Model = $d.Product } }
    } elseif ($known.Count -gt 1) {
        Say ''
        Say '  Found:' White
        for ($i = 0; $i -lt $known.Count; $i++) { Say ('    {0}. {1} ({2})' -f ($i + 1), $(if ($known[$i].Product) { $known[$i].Product } else { 'unnamed' }), $known[$i].Id) White }
        $a = (Read-Host '  Which one is it? Its number, or Enter if it is not in the list').Trim()
        $n = 0
        if ([int]::TryParse($a, [ref]$n) -and $n -ge 1 -and $n -le $known.Count) { return [pscustomobject]@{ Paths = $known[$n - 1].Paths; Model = $known[$n - 1].Product } }
    }
    return [pscustomobject]@{ Paths = @(WaitForDevice -Unplug); Model = $null }
}

function IsAdmin {
    ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function SaveText([string]$path, [string[]]$lines) {
    [IO.File]::WriteAllText($path, ($lines -join "`r`n") + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
}

# ---- Recording ---------------------------------------------------------------------
# One row per step: id | mouse, keyboard or both | group | the value to set |
# the series it belongs to (steps whose values the maintainer's reader lines
# up) | flags | what to do. Flags: window (pictures start once the official
# software's window is clicked), auto15 (moves on by itself after 15 s),
# repeat (one recording per choice in a list), attach (opens a folder for
# exported files), detect (a newly plugged receiver joins the recording),
# undo (puts back what the group's earlier steps changed; until one is done,
# that change is still on the device, and the end of the recording says so),
# nochange (changes nothing that would need putting back). A disruptive change
# (a remapped key, a key mode) is put back by the very next step.
$StepTable = @'
start.open|both|Start|||window|Open the official software for your device and wait until it shows the device. Change nothing yet. Click once on its window, then click Done here.
start.idle|both|Start|||auto15|Leave everything alone for 15 seconds: no clicks, no changes. This shows what the software does on its own.
start.info|both|Start||||If the software shows the device's firmware version or other information somewhere, open that page. Never start a firmware update.
start.tour|both|Start||||Open every page or tab of the software once, without changing anything. Then go back to the main page.
dpi.s1.400|mouse|DPI|400|dpi.s1||Set DPI stage 1 to 400.
dpi.s1.3200|mouse|DPI|3200|dpi.s1||Set DPI stage 1 to 3200.
dpi.s1.100|mouse|DPI|100|dpi.s1|ask|Set DPI stage 1 to 100, or to the lowest value it allows. Type the value it shows now.
dpi.s1.1000|mouse|DPI|1000|dpi.s1||Set DPI stage 1 to 1000.
dpi.s1.12000|mouse|DPI|12000|dpi.s1||Set DPI stage 1 to 12000.
dpi.s1.max|mouse|DPI|max|dpi.s1|ask|Set DPI stage 1 to the highest value it allows. Type the value it shows now.
dpi.s1.back|mouse|DPI||dpi.s1|undo ask|Set DPI stage 1 back to what you use (800 if unsure). Type the value it shows now.
dpi.s2.1200|mouse|DPI|1200|dpi.s2||Set DPI stage 2 to 1200 (only stage 2).
dpi.s2.2400|mouse|DPI|2400|dpi.s2||Set DPI stage 2 to 2400.
dpi.s2.back|mouse|DPI|||undo|Set DPI stage 2 back to what you use.
dpi.count.2|mouse|DPI|2|dpi.count||If you can choose how many DPI stages there are: set it to 2.
dpi.count.4|mouse|DPI|4|dpi.count||Set the number of DPI stages to 4.
dpi.count.back|mouse|DPI|||undo|Set the number of DPI stages back to what you use.
dpi.active.2|mouse|DPI|2|dpi.active||In the software, make stage 2 the active (current) DPI stage.
dpi.active.1|mouse|DPI|1|dpi.active|undo|Make stage 1 the active stage again.
dpi.button|mouse|DPI|||nochange|Press the DPI button on the mouse once, then press it again until stage 1 is back.
dpi.red|mouse|DPI|#FF0000|dpi.color||If DPI stages have colours: set stage 1's colour to pure red (#FF0000: red 255, green 0, blue 0).
dpi.blue|mouse|DPI|#0000FF|dpi.color||Set stage 1's colour to pure blue (#0000FF).
dpi.color.back|mouse|DPI|||undo|Set stage 1's colour back to what you use.
dpi.xy|mouse|DPI|800x1600|||If X and Y can be set apart: set stage 1 to X 800 and Y 1600.
dpi.xy.off|mouse|DPI|||undo|Turn separate X and Y off again.
dyn.on|mouse|DPI|on|dyn||If offered: turn dynamic DPI (DPI that rises with speed, set as a curve) on, with any curve.
dyn.off|mouse|DPI|off|dyn|undo|Turn dynamic DPI off (back on afterwards, if you use it).
poll.125|both|Polling rate|125|poll||Set the polling rate (report rate) to 125 Hz.
poll.500|both|Polling rate|500|poll||Set the polling rate to 500 Hz.
poll.1000|both|Polling rate|1000|poll||Set the polling rate to 1000 Hz.
poll.4000|both|Polling rate|4000|poll||Set the polling rate to 4000 Hz, if offered.
poll.8000|both|Polling rate|8000|poll||Set the polling rate to 8000 Hz, if offered.
poll.back|both|Polling rate||poll|undo ask|Set the polling rate back to what you use (1000 Hz if unsure). Type the value it shows now.
lod.low|mouse|Sensor|low|lod|ask|Set the lift-off distance (LOD) to its lowest setting (often 1 mm). Type the value it shows now.
lod.high|mouse|Sensor|high|lod|ask|Set the lift-off distance to its highest setting (often 2 mm). Type the value it shows now.
lod.back|mouse|Sensor|||undo|Set the lift-off distance back to what you use.
angle.on|mouse|Sensor|on|angle||Turn angle snapping (straight-line correction) on.
angle.off|mouse|Sensor|off|angle|undo|Turn angle snapping off (back on afterwards, if you use it).
ripple.on|mouse|Sensor|on|ripple||Turn ripple control on.
ripple.off|mouse|Sensor|off|ripple|undo|Turn ripple control off (back on afterwards, if you use it).
motion.on|mouse|Sensor|on|motion||Turn motion sync on.
motion.off|mouse|Sensor|off|motion|undo|Turn motion sync off (back on afterwards, if you use it).
mode.each|mouse|Sensor||sensor.mode|repeat|If the mouse has sensor or performance modes (Office, Gaming, Competitive...): choose the first one, type its name in the note, click Save this one. Then the next mode, and so on.
mode.back|mouse|Sensor|||undo|Choose the mode you use again.
fps.on|mouse|Sensor|on|fps||If offered: turn 20 kHz FPS scanning (the highest sensor frame rate) on.
fps.off|mouse|Sensor|off|fps|undo|Turn 20 kHz FPS scanning off (back on afterwards, if you use it).
far.on|mouse|Sensor|on|far||If offered: turn long-distance mode (a stronger wireless link) on.
far.off|mouse|Sensor|off|far|undo|Turn long-distance mode off (back on afterwards, if you use it).
perf.on|mouse|Sensor|on|perf||If offered: turn the highest-performance mode on.
perf.off|mouse|Sensor|off|perf|undo|Turn the highest-performance mode off (back on afterwards, if you use it).
anglemode.10|mouse|Sensor|10||ask|If offered: set the mouse angle (a slider in degrees, not angle snapping) to 10 degrees, or the closest value. Type the value it shows now.
anglemode.back|mouse|Sensor|||undo|Set the mouse angle back to what you use.
debounce.min|both|Response|min|debounce|ask|Set the debounce time (button or key response, often in ms) to its lowest value. Type the value it shows now.
debounce.max|both|Response|max|debounce|ask|Set the debounce time to its highest value. Type the value it shows now.
debounce.4|both|Response|4|debounce|ask|Set the debounce time to 4 ms, or the closest value. Type the value it shows now.
debounce.back|both|Response|||undo|Set the debounce time back to what you use.
sleep.min|both|Power|min|sleep|ask|Set the sleep (power saving) time to its shortest. Type the value it shows now.
sleep.max|both|Power|max|sleep|ask|Set the sleep time to its longest. Type the value it shows now.
sleep.10|both|Power|10|sleep|ask|Set the sleep time to 10 minutes, or the closest. Type the value it shows now.
sleep.back|both|Power|||undo|Set the sleep time back to what you use.
deep.min|both|Power|min|deep|ask|If there is a second, deeper sleep time: set it to its shortest. Type the value it shows now.
deep.max|both|Power|max|deep|ask|Set the deep sleep time to its longest. Type the value it shows now.
deep.back|both|Power|||undo|Set the deep sleep time back to what you use.
btn.b4.middle|mouse|Buttons|Middle click|btn.b4||Set button 4, the side button nearer the FRONT of the mouse ("Forward"), to Middle click.
btn.b4.key-a|mouse|Buttons|key A|btn.b4||Set button 4 (front side button) to the keyboard key A.
btn.b4.ctrl-c|mouse|Buttons|Ctrl+C|btn.b4||Set button 4 (front side button) to the shortcut Ctrl + C.
btn.b4.vol-up|mouse|Buttons|Volume up|btn.b4||Set button 4 (front side button) to Volume up.
btn.b4.vol-down|mouse|Buttons|Volume down|btn.b4||Set button 4 (front side button) to Volume down.
btn.b4.play|mouse|Buttons|Play/Pause|btn.b4||Set button 4 (front side button) to Play / Pause.
btn.b4.next|mouse|Buttons|Next track|btn.b4||Set button 4 (front side button) to Next track.
btn.b4.dpi-up|mouse|Buttons|DPI up|btn.b4||Set button 4 (front side button) to DPI up (or DPI cycle).
btn.b4.dpi-down|mouse|Buttons|DPI down|btn.b4||Set button 4 (front side button) to DPI down, if offered.
btn.b4.scroll-up|mouse|Buttons|Scroll up|btn.b4||Set button 4 (front side button) to Scroll up, if offered.
btn.b4.fire|mouse|Buttons|Fire|btn.b4|ask|Set button 4 (front side button) to fire key (rapid fire), if offered. Type its settings as the software shows them (clicks, speed).
btn.b4.off|mouse|Buttons|Disabled|btn.b4||Set button 4 (front side button) to Disabled (off).
btn.b4.default|mouse|Buttons|Forward|btn.b4|undo|Set button 4 (front side button) back to its default (Forward).
btn.b5.key-b|mouse|Buttons|key B|||Set button 5, the side button nearer the REAR of the mouse ("Back"), to the keyboard key B.
btn.b5.default|mouse|Buttons|Back||undo|Set button 5 (rear side button) to its default again (Back).
btn.mid.key-c|mouse|Buttons|key C|||Set the middle button (wheel click) to the keyboard key C.
btn.mid.default|mouse|Buttons|Middle click||undo|Set the middle button back to Middle click.
btn.reset|mouse|Buttons||||Optional, only if you do not mind losing your own button settings: restore all buttons to their defaults at once.
media.prev|mouse|Media keys|Previous Track|media.b4||Set button 4 (front side button) to the media key Previous track.
media.stop|mouse|Media keys|Stop Playback|media.b4||Set button 4 (front side button) to Stop (stops the music or video), if offered.
media.mute|mouse|Media keys|Mute|media.b4||Set button 4 (front side button) to Mute.
media.player|mouse|Media keys|Media player|media.b4||Set button 4 (front side button) to open the media player, if offered.
media.email|mouse|Media keys|Email|media.b4||Set button 4 (front side button) to open e-mail (Mail), if offered.
media.calc|mouse|Media keys|Calculator|media.b4||Set button 4 (front side button) to open the calculator, if offered.
media.computer|mouse|Media keys|My Computer|media.b4||Set button 4 (front side button) to open My Computer (This PC), if offered.
media.home|mouse|Media keys|Homepage|media.b4||Set button 4 (front side button) to the browser's Home page, if offered.
media.search|mouse|Media keys|Search|media.b4||Set button 4 (front side button) to Search, if offered.
media.back|mouse|Media keys|Previous page|media.b4||Set button 4 (front side button) to the browser's Back (previous page), if offered.
media.forward|mouse|Media keys|Next page|media.b4||Set button 4 (front side button) to the browser's Forward (next page), if offered.
media.halt|mouse|Media keys|Stop page|media.b4||Set button 4 (front side button) to the browser's Stop (stops loading the page), if offered.
media.refresh|mouse|Media keys|Refresh page|media.b4||Set button 4 (front side button) to the browser's Refresh, if offered.
media.favorites|mouse|Media keys|Favorites|media.b4||Set button 4 (front side button) to Favorites (bookmarks), if offered.
media.default|mouse|Media keys|Forward|media.b4|undo|Set button 4 (front side button) back to its default (Forward).
key.a-b|keyboard|Keys|A types B|||Remap the key A so that it types B (main layer).
key.a-b.undo|keyboard|Keys|A types A||undo|Reset A (Reset Key), so it types A again.
key.caps-ctrl|keyboard|Keys|Caps Lock is Left Ctrl|||Remap Caps Lock to Left Ctrl.
key.caps-ctrl.undo|keyboard|Keys|Caps Lock is Caps Lock||undo|Reset Caps Lock (Reset Key), so it is Caps Lock again.
key.f1-volup|keyboard|Keys|F1 is Volume up|||Remap F1 to Volume up: a media key (in Attack Shark Driver v4, Custom Keys > Functions).
key.f1-volup.undo|keyboard|Keys|F1 is F1||undo|Reset F1 (Reset Key), so it is F1 again.
key.esc-mute|keyboard|Keys|Esc is Mute|||Remap Esc to Mute: a media key (Custom Keys > Functions in Attack Shark Driver v4).
key.esc-mute.undo|keyboard|Keys|Esc is Esc||undo|Reset Esc (Reset Key), so it is Esc again.
key.fn|keyboard|Keys|Fn + key is Play/Pause|||If there is an Fn layer: give Play / Pause (a media key: Functions) to Fn + a key the software lets you change (some, like Fn + A, are fixed): Fn + P, say. Type the key in the note.
key.fn.undo|keyboard|Keys|||undo|Reset that Fn + key (Reset Key), so it is as it was.
key.reset|keyboard|Keys||||Optional, only if you do not mind losing your own key settings: restore all keys to their defaults at once.
winlock.on|keyboard|Keys|on|winlock||If the software has a Windows-key lock (Win Lock, or game mode: the Windows key stops opening the Start menu during a game): turn it on. Not there? Click Not in my software.
winlock.off|keyboard|Keys|off|winlock|undo|Turn the Windows-key lock off again.
rollover.6|keyboard|Keys|6KRO|rollover||If the software lets you choose how many keys can be pressed at once (6KRO or NKRO): choose 6KRO. Not there? Click Not in my software.
rollover.n|keyboard|Keys|NKRO|rollover|undo|Choose NKRO again.
knob.left|keyboard|Knob|Knob left is Page Down|||If the keyboard has a knob or a wheel: remap turning it down (Volume down) to Page Down. In Attack Shark Driver v4 it is on the picture in Custom Keys.
knob.left.undo|keyboard|Knob|||undo|Reset the knob's turn down (Reset Key), so it is Volume down again.
knob.press|keyboard|Knob|Knob press is Play/Pause|||Remap pressing the knob (Mute) to Play / Pause: a media key (Functions).
knob.press.undo|keyboard|Knob|||undo|Reset the knob's press (Reset Key), so it is Mute again.
knob.fn|keyboard|Knob|Fn + knob right is Next track|||If the Fn layer lets you change the knob: give Fn + turning it up the action Next track. Shown but not clickable? Click Not in my software.
knob.fn.undo|keyboard|Knob|||undo|Reset Fn + turning the knob up (Reset Key).
opt.mac|keyboard|Options|Mac|os||If the software has a Windows / Mac mode: switch it to Mac. A mode only a key combination on the keyboard switches does not count: click Not in my software.
opt.win|keyboard|Options|Windows|os|undo|Switch it back to Windows.
opt.wasd|keyboard|Options|on|wasd||If offered: swap WASD and the arrow keys.
opt.wasd.off|keyboard|Options|off|wasd|undo|Swap them back.
opt.mistouch|keyboard|Options|on|mistouch||If offered: turn the anti-accidental trigger (anti-mistouch) on.
opt.mistouch.off|keyboard|Options|off|mistouch|undo|Turn it off again (back on afterwards, if you use it).
opt.rtstab|keyboard|Options|on|rtstab|ask|If offered: set RT stabilisation to 50% (a percentage, 25% from the factory). Type the value it shows now.
opt.rtstab.off|keyboard|Options|off|rtstab|undo|Set RT stabilisation back to what it was (25% if unsure).
macro.make|both|Macros||||Create a macro named T1 that types the letter a, then the letter b (record it, or add the four events by hand: a down, a up, b down, b up). Save it. It may reach the keyboard only once given to a key: the next steps.
macro.delay|both|Macros|300|||If delays can be edited: change the delay between A and B to 300 ms, and save.
macro.assign.mouse|mouse|Macros||||Assign the macro T1 to button 4.
macro.assign.keyboard|keyboard|Macros||||Assign the macro T1 to the key F12.
macro.repeat|both|Macros|3|||If offered: make the macro repeat 3 times.
macro.second.mouse|mouse|Macros||||If the software keeps more than one macro: create a second macro named T2 that types the letter c, then the letter d, and assign it to button 5. If it says how many macros it can hold, type that number in the note.
macro.second.keyboard|keyboard|Macros||||If the software keeps more than one macro: create a second macro named T2 that types the letter c, then the letter d, and assign it to the key F11. If it says how many macros it can hold, type that number in the note.
macro.clear|both|Macros|||undo|Reset those buttons or keys (Reset Key) so they are as before, then delete the macros.
light.each|both|Lighting||light.effect|repeat|Choose the first lighting effect in the list and wait 2 seconds. Type its name in the note, click Save this one. Then the next effect, and so on.
light.red|both|Lighting|#FF0000|light.color||Choose the effect that lights every key in one colour (Always on, or Static), and set its colour to pure red (#FF0000).
light.blue|both|Lighting|#0000FF|light.color||Set the colour to pure blue (#0000FF).
light.dim|both|Lighting|min|light.bright||Set the brightness to its lowest (not off).
light.bright|both|Lighting|max|light.bright||Set the brightness to its highest.
light.half|both|Lighting|50%|light.bright||Set the brightness to the middle.
light.slow|both|Lighting|min|light.speed||Choose a moving effect, then set its speed to the slowest.
light.fast|both|Lighting|max|light.speed||Set the speed to the fastest.
light.dir|both|Lighting||||Choose an effect that moves (Wave, say), then change its direction once.
light.off|both|Lighting|off|light.power||Turn the lighting off: the Off effect, or an off switch. Neither? Set the brightness to 0.
light.on|both|Lighting|on|light.power||Turn the lighting on again, as it was.
light.back|both|Lighting|||undo|Put your own lighting back (effect, colour, brightness), as near as you remember it.
perkey.esc|keyboard|Per-key lighting|#FF0000|||If single keys can have their own colour: make Esc red and leave the rest.
perkey.space|keyboard|Per-key lighting|#0000FF|||Make the space bar blue as well.
perkey.clear|keyboard|Per-key lighting|||undo|Clear these custom colours.
side.each|both|Second light||side.effect|repeat|If there is a second light (side strip, logo, receiver): choose its first effect, type its name in the note, click Save this one. Then its next effect, and so on.
side.red|both|Second light|#FF0000|side.color||Set the second light to pure red (#FF0000).
side.blue|both|Second light|#0000FF|side.color||Set the second light to pure blue (#0000FF).
side.back|both|Second light|||undo|Put the second light back as you had it.
rled.change|mouse|Receiver light|||ask|If the wireless receiver has a light you can set: change its effect or colour once. Type what you set.
rled.back|mouse|Receiver light|||undo|Set the receiver's light back to what you use.
act.3.5|keyboard|Actuation|3.5|act.all|ask|Select all keys (Select all), then set their actuation to 3.5 mm, or the deepest it allows. Type the value it shows now.
act.0.5|keyboard|Actuation|0.5|act.all|ask|With all keys selected, set their actuation to 0.5 mm, or the least it allows. That is very light: until the next step, a key just touched may type. Type the value it shows now.
act.back|keyboard|Actuation||act.all|undo ask|Set all keys back to what you use (2.0 mm if unsure). Type the value it shows now.
act.esc|keyboard|Actuation|1.0||ask|Select only Esc, and set its actuation to 1.0 mm. Type the value it shows now.
act.esc.undo|keyboard|Actuation|||undo|Set Esc back to the same as the other keys.
rt.on|keyboard|Actuation|on|rt||Turn rapid trigger on for all keys (Select all, then rapid trigger).
rt.0.1|keyboard|Actuation|0.1|rt.sens||Set the rapid trigger sensitivity to 0.1 mm.
rt.0.5|keyboard|Actuation|0.5|rt.sens||Set the rapid trigger sensitivity to 0.5 mm.
rt.off|keyboard|Actuation|off|rt|undo|Turn rapid trigger off (back on afterwards, if you use it).
dz.top|keyboard|Actuation|0.2||ask|If offered: set the top dead zone (the travel ignored as a key starts to move) to 0.2 mm, for all keys. Type the value it shows now.
dz.top.undo|keyboard|Actuation|||undo|Set the top dead zone back as it was.
dz.bottom|keyboard|Actuation|0.2||ask|If offered: set the bottom dead zone (the travel ignored at the bottom) to 0.2 mm, for all keys. Type the value it shows now.
dz.bottom.undo|keyboard|Actuation|||undo|Set the bottom dead zone back as it was.
travel|keyboard|Actuation|||nochange|If the software shows key travel live (in Attack Shark Driver v4, press Simulation Setting first): open that view, press A slowly to the bottom, and release it.
sw.show|keyboard|Switches|||ask,nochange|If the software sets which switch each key has: open that page, change nothing. Type the switch it shows for Esc, and for A (for example: Esc Magnetic Jade, A Magnetic Jade).
sw.esc|keyboard|Switches|||ask|Select only Esc (unselect any other key), and set its switch to another type in the list. Type the name you chose.
sw.esc.back|keyboard|Switches|||undo|Set Esc's switch back to what it showed before.
dks.a|keyboard|Key modes||||Give the key A a dynamic keystroke (DKS, in Advanced Key Settings) with any actions, and save.
mt.a|keyboard|Key modes||||Give A a mod-tap (Click - MT in Attack Shark Driver v4): tap types A, hold is Left Ctrl. Save. It takes the place of the DKS.
tgl.a|keyboard|Key modes||||Give A a toggle (Toggle Switch - TGL). Save. It takes the place of the mod-tap.
modereset.a|keyboard|Key modes|||undo|Reset A (Reset Key, in Advanced Key Settings), so it is a plain key again.
snap.ad|keyboard|Key modes||||Turn on SnapKey (Snap Tap, SOCD) for A and D, in Advanced Key Settings.
snap.ad.undo|keyboard|Key modes|||undo|Reset it (Reset Key on A resets A and D together).
calibrate|keyboard|Key modes|||nochange|Optional: run the key calibration, following its instructions.
profile.2|both|Profiles|2|profile||Switch to onboard profile 2.
profile.1|both|Profiles|1|profile|undo|Switch back to profile 1 (or the one you use).
profile.export|both|Profiles|||attach|If the software can export your settings to a file: export one into the folder that just opened.
conn.other|both|Other connection|||detect|Now connect it the other way it can be connected. On its USB receiver now? Plug in its cable (and set its switch to wired, if it has one). On its cable now? Plug in its receiver and switch it to 2.4 GHz. Wait until the software shows it. Only one way? Click Not in my software.
conn.idle|both|Other connection|||auto15|Leave everything alone for 15 seconds.
conn.dpi.1600|mouse|Other connection|1600|conn.dpi||Set DPI stage 1 to 1600.
conn.dpi.back|mouse|Other connection||conn.dpi|undo ask|Set DPI stage 1 back to what you use. Type the value it shows now.
conn.poll.500|both|Other connection|500|conn.poll||Set the polling rate to 500 Hz.
conn.poll.back|both|Other connection||conn.poll|undo ask|Set the polling rate back to what you use. Type the value it shows now.
conn.green|both|Other connection|#00FF00|||Set the lighting to static pure green (#00FF00).
conn.light.back|both|Other connection|||undo|Put your own lighting back.
conn.pair|both|Other connection|||nochange|If the software has a pairing button for the receiver: click it and follow its instructions until the device works again.
end.reset|both|Finish||||Restore the factory settings in the software (Reset, Reset Profile or Restore defaults): it tells Shark Deck the factory values. Your own settings come back from the file you exported, or set them again afterwards. Rather not? Click Not in my software.
end.reopen|both|Finish|||nochange|Close the official software, open it again and wait until it shows the device. Change nothing: it reads every setting back from the device.
end.close|both|Finish||||Close the official software.
'@

# Where each group's settings usually are, shown under each step: Attack
# Shark's keyboard software first (Attack Shark Driver v4, as its English
# menus name them), then what other software tends to call them.
$WhereTable = @'
Polling rate|keyboard|Attack Shark Driver v4: Keyboard Settings > Other Settings (Keyboard Polling Rate). Elsewhere: Settings or Performance, as "polling rate" or "report rate".
Polling rate|mouse|Usually the main page, or Settings / Performance, as "polling rate" or "report rate".
Response|keyboard|Attack Shark Driver v4: Keyboard Settings > Other Settings, if it has it. Elsewhere: Settings or Performance, as "debounce" or "response time".
Response|mouse|Usually Settings or Performance, as "debounce" or "response time".
Power|keyboard|Attack Shark Driver v4: Keyboard Settings > Other Settings, if it has it (a wired keyboard may have no sleep time). Elsewhere: Settings, as "sleep time" or "power saving".
Power|mouse|Usually Settings, as "sleep time" or "power saving".
DPI|mouse|Usually the main page: the DPI stages and their values.
Sensor|mouse|Usually Settings, Performance or Sensor: lift-off distance (LOD), angle snapping, ripple control, motion sync.
Buttons|mouse|Usually the main page or a Buttons / Key settings tab: click the button on the picture of the mouse, then choose what it does.
Media keys|mouse|Where buttons are set: click button 4 (the front side button) on the picture of the mouse, then look under Multimedia (or Media).
Keys|keyboard|Attack Shark Driver v4: Keyboard Settings > Custom Keys: click the key on the picture, then choose (media keys: Functions); Reset Key puts one back. Fn + key: Fn Layer Settings. Elsewhere: Keys, Keymap or Remap.
Macros|keyboard|Attack Shark Driver v4: Macro Editing makes it; Keyboard Settings > Custom Keys > Macro Settings gives it to a key. Elsewhere: a Macro tab.
Macros|mouse|Usually a Macro tab; a macro is then given to a button where buttons are set.
Lighting|keyboard|Attack Shark Driver v4: Light Settings. Elsewhere: Lighting, Light or RGB.
Lighting|mouse|Usually Lighting, Light or RGB.
Per-key lighting|keyboard|Attack Shark Driver v4: Light Settings, its custom (user) effect. Elsewhere: Lighting > Custom or Per-key.
Second light|both|Usually in Lighting: a side light, a logo light, or the receiver's light.
Actuation|keyboard|Attack Shark Driver v4: Keyboard Settings > Magnetic Switch Settings. Elsewhere: Performance, Magnetic switch or Trigger.
Key modes|keyboard|Attack Shark Driver v4: Keyboard Settings > Advanced Key Settings (DKS, MT, Toggle, SnapKey); calibration: the Travel Calibration button. Elsewhere: Advanced keys or Performance.
Profiles|keyboard|Attack Shark Driver v4: the Profile 1 list on the Keyboard Settings page (the Profile menu on the left is your account). Elsewhere: Profile 1, 2, 3... at the top or the side.
Profiles|mouse|Usually at the top or the side: Profile 1, 2, 3... or Config 1, 2, 3...
Other connection|both|Usually where the software shows the connection: cable, 2.4 GHz receiver, Bluetooth. A switch under the device often chooses it.
Finish|keyboard|Attack Shark Driver v4: Restore Factory Settings, bottom right of the Keyboard Settings page.
Knob|keyboard|Attack Shark Driver v4: Keyboard Settings > Custom Keys, where the knob shows as Volume -, Volume + and Mute (Fn + knob: Fn Layer Settings). Elsewhere: Custom keys or Key settings.
Options|keyboard|Attack Shark Driver v4: Keyboard Settings > Other Settings. Elsewhere: Settings.
Switches|keyboard|Attack Shark Driver v4: Keyboard Settings > Magnetic Switch Settings, where each key's switch type is set. Elsewhere: Magnetic switch or Switch settings.
Receiver light|mouse|Usually Lighting, or a Receiver page: the light on the wireless receiver.
'@

function WhereFor([string]$kind) {
    $map = @{}
    foreach ($line in ($WhereTable -split "`r?`n")) {
        $f = $line -split '\|', 3
        if ($f.Count -lt 3) { continue }
        if ($f[1] -ne 'both' -and $f[1] -ne $kind) { continue }
        $map[$f[0]] = $f[2]
    }
    $map
}

# A short recording of one thing the owner chooses, described in the notes:
# a setting Shark Deck lacks, or one that does not work in it.
$CustomStepTable = @'
start.open|both|Start|||window|Open the official software for your device and wait until it shows the device. Click once on its window, then click Done here.
custom.each|both|Your recording|||repeat,describe|Do one thing in the official software: the setting Shark Deck should learn, or the one that does not work in it. Write in the note what you did (and what you expected), click Save this one, then do the next thing. After the last one, click That was the last one.
end.close|both|Finish||||Close the official software.
'@

# The steps Shark Deck asks an owner for by name (--steps deep,macro,specific):
# opening the software, every step whose id starts with one of the words, the
# "something specific" step for 'specific', then closing the software.
function StepTableFor([string]$steps) {
    $want = @($steps -split ',' | Where-Object { $_ })
    $lines = @($StepTable -split "`r?`n")
    $out = New-Object System.Collections.Generic.List[string]
    foreach ($line in $lines) {
        $id = ($line -split '\|', 2)[0]
        if ($id -eq 'end.close') { continue }
        if ($id -eq 'start.open' -or $want -contains ($id -split '\.', 2)[0]) { $out.Add($line) }
    }
    if ($want -contains 'specific') {
        foreach ($line in @($CustomStepTable -split "`r?`n")) { if ($line -like 'custom.each|*') { $out.Add($line) } }
    }
    foreach ($line in $lines) { if ($line -like 'end.close|*') { $out.Add($line) } }
    $out -join "`r`n"
}

function StepList([string]$kind, [string]$table = $StepTable) {
    $list = New-Object System.Collections.Generic.List[SdStep]
    foreach ($line in ($table -split "`r?`n")) {
        $f = $line -split '\|', 7
        if ($f.Count -lt 7) { continue }
        if ($f[1] -ne 'both' -and $f[1] -ne $kind) { continue }
        $s = New-Object SdStep
        $s.Id = $f[0]; $s.Kind = $f[1]; $s.Group = $f[2]; $s.Value = $f[3]; $s.Series = $f[4]; $s.Flags = $f[5]; $s.Text = $f[6]
        $list.Add($s)
    }
    , $list.ToArray()
}

function FindUsbPcap {
    $dirs = @($env:ProgramFiles, $env:ProgramW6432, ${env:ProgramFiles(x86)}) | Where-Object { $_ } | Select-Object -Unique
    foreach ($d in $dirs) {
        foreach ($p in @((Join-Path $d 'USBPcap\USBPcapCMD.exe'), (Join-Path $d 'Wireshark\extcap\USBPcapCMD.exe'), (Join-Path $d 'Wireshark\extcap\wireshark\USBPcapCMD.exe'))) {
            if (Test-Path -LiteralPath $p) { return $p }
        }
    }
    return $null
}

# 'Running', 'Stopped' ... or 'missing': USBPcap's driver, as Windows sees it.
function UsbPcapDriver {
    try {
        Add-Type -AssemblyName System.ServiceProcess
        $drv = @([System.ServiceProcess.ServiceController]::GetDevices() | Where-Object { $_.ServiceName -eq 'USBPcap' })
        if ($drv.Count -gt 0) { return [string]$drv[0].Status }
    } catch { }
    return 'missing'
}

function ExplainUsbPcap([string]$why) {
    Say ''
    if ($why -eq 'missing') {
        Say '  A recording needs USBPcap, a free USB capture driver (the one Wireshark uses), and it is' White
        Say '  missing or only half installed. Run this tool again: it offers to install it. Or install' White
        Say '  it yourself from this page, restart the computer, then run this tool again:' White
        Say "     $UsbPcapUrl" Cyan
    } elseif ($why -eq 'blocked') {
        Say '  Windows refused to load the USBPcap driver (its Code Integrity log says so).' Red
        Say '  This is most likely Windows Security''s "Memory integrity" (Device security > Core' White
        Say '  isolation details). Turning it off lowers the PC''s protection, so it is your call. If you' White
        Say '  do: restart, then run this tool again. Once the recording is sent, uninstall USBPcap' White
        Say '  (Settings > Apps) and turn Memory integrity back on.' White
    } else {
        Say '  USBPcap is installed, but it did not start with Windows, and Windows does not say why.' Yellow
        Say '  Uninstall it (Settings > Apps > USBPcap), restart the computer, then run this tool' White
        Say '  again: it installs USBPcap afresh.' White
    }
}

# After the report: offers a recording, and starts it with administrator rights.
# Returns 'declined', 'started', 'restart' or 'needs-usbpcap'.
function OfferRecording($report, [string[]]$readable, [string]$reportFile, [string]$outDir, [bool]$asked, [string]$steps, [string]$kind) {
    $families = @($report.devices | ForEach-Object { $_.family })
    $spoken = @($families | Where-Object { $SpokenFamilies -contains $_ }).Count -eq $families.Count
    Say ''
    if (-not $asked) {
        Say '  Next, the recording: a small window walks you through the official software, one setting' White
        Say '  at a time, while USBPcap (a free USB capture driver) records what goes over the cable.' White
        Say '  About 25 minutes. Only this device''s traffic is kept, never what you type on it,' White
        Say '  and nothing is sent anywhere.' DarkGray
        if ($spoken) { Say '  Shark Deck already speaks this family''s language: a recording shows what is new.' DarkGray }
        $a = Read-Host '  Record now? [Y/n]'
        if ($a -match '^\s*[nN]') { return 'declined' }
    }
    if ($steps) {
        Say ''
        # Named as the steps' own groups ("Media keys"), not by the words that picked them.
        $asked = @((StepTableFor $steps) -split "`r?`n" | ForEach-Object { ($_ -split '\|')[2] } | Where-Object { $_ -and $_ -ne 'Start' -and $_ -ne 'Finish' } | Select-Object -Unique)
        Say ('  Shark Deck asked for a short recording, of these settings only: ' + ($asked -join ', ') + '.') White
        $custom = $false
    } elseif (-not $asked) {
        Say ''
        Say '  What to record:' White
        Say '    1  Everything, one setting at a time (about 25 minutes): for a device Shark Deck does not know yet.' White
        Say '    2  Something specific (a few minutes): a setting missing from Shark Deck, or one that does not work.' White
        Say '       You do it in the official software and write in a note what you did.' DarkGray
        $custom = (Read-Host '  1 or 2 [1]') -match '^\s*2'
    } else { $custom = $false }
    $state = [ordered]@{ report = $report; readable = $readable; reportFile = $reportFile; outDir = $outDir; custom = $custom; steps = $steps; kind = $kind }
    # Missing, or only half there: its files without its driver (after an uninstall, say).
    if (-not (FindUsbPcap) -or (UsbPcapDriver) -eq 'missing') {
        $installed = InstallUsbPcap $state
        if ($installed -ne 'installed') {
            if ($installed -ne 'refused') { ExplainUsbPcap 'missing' }
            return 'needs-usbpcap'
        }
        RestartForUsbPcap
        return 'restart'
    }
    if (@(UsbPcapHubs (FindUsbPcap)).Count -eq 0 -and (UsbPcapNeedsRestart)) {
        # Installed since Windows last started: the restart puts it on every USB
        # hub, so Windows has to accept it first.
        Say ''
        Say '  USBPcap is installed, and starts listening once the computer restarts. First, this tool' White
        Say '  checks that Windows accepts its driver: Windows asks for permission.' White
        SaveResume $state
        $check = UsbPcapSetup $null
        if (-not $check) { ClearResume; Say '  Not checked: permission refused. Your report above is saved all the same.' Yellow; return 'declined' }
        if (-not $check.loads) { ClearResume; SayRefused $check; return 'needs-usbpcap' }
        RestartForUsbPcap
        return 'restart'
    }
    # Listening, or not even after a restart: the recording window says why.
    return StartRecording $state
}

# The recording needs administrator rights: it runs right here when this window
# has them (after a restart, Windows opens it that way), else in a second window
# Windows opens with them.
function StartRecording($state) {
    $statePath = Join-Path ([IO.Path]::GetTempPath()) ('SharkDeck-recording-{0}.json' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    [IO.File]::WriteAllText($statePath, ($state | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding($false)))
    # Base64, so a path with spaces passes through cmd.exe untouched.
    $token = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($statePath))
    if (IsAdmin) { RecordingPhase $token; exit 0 }
    Say ''
    Say '  Windows now asks for permission: USBPcap only records with administrator rights.' Yellow
    try {
        # Windows' own cmd.exe is what gets elevated, running this file: a downloaded
        # .bat elevated directly can draw the "open this file?" warning on top.
        Start-Process -FilePath $env:ComSpec -ArgumentList ('/c ""' + $env:SD_REPORT_SELF + '" --recording-of ' + $token + '"') -Verb RunAs | Out-Null
        Say '  The recording goes on in the new window. You can close this one.' Green
        return 'started'
    } catch {
        Remove-Item -LiteralPath $statePath -ErrorAction SilentlyContinue
        Say '  Not started: permission refused. Your report above is saved all the same.' Yellow
        return 'declined'
    }
}

# USBPcap, installed for the owner: with their OK, from the official release,
# run only if it is byte for byte the file Wireshark ships, and kept only if
# Windows accepts its driver. Returns 'installed', 'declined', 'failed' or
# 'refused' (Windows refused the driver).
function InstallUsbPcap($state) {
    Say ''
    Say '  A recording needs USBPcap, a free USB capture driver (the one Wireshark uses).' White
    Say '  This tool can install it for you: it downloads USBPcap 1.5.4.0 (190 KB) from its official' White
    Say '  page on GitHub, checks that it is exactly the file Wireshark ships, runs its installer,' White
    Say '  and makes sure Windows accepts its driver. The computer then needs a restart; when you' White
    Say '  sign in again, the recording opens by itself.' White
    $a = Read-Host '  Install USBPcap now? [Y/n]'
    if ($a -match '^\s*[nN]') { return 'declined' }
    $dir = Join-Path ([IO.Path]::GetTempPath()) "SharkDeck-USBPcap-$PID"
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $exe = Join-Path $dir 'USBPcapSetup-1.5.4.0.exe'
    try {
        Say '  Downloading...' DarkGray
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri $UsbPcapInstallerUrl -OutFile $exe -UseBasicParsing
        $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $exe).Hash
        if ($hash -ne $UsbPcapInstallerSha256) {
            Say '  The file downloaded is not the expected one. It was deleted, and nothing was run.' Red
            return 'failed'
        }
        $signer = Get-AuthenticodeSignature -LiteralPath $exe
        if ($signer.Status -eq 'Valid') { Say "  Checked. Signed by: $($signer.SignerCertificate.GetNameInfo('SimpleName', $false))" DarkGray }
        # Set to carry on before anything can restart the computer.
        SaveResume $state
        Say '  Installing USBPcap: Windows asks for permission, then it takes a minute.' Yellow
        $setup = UsbPcapSetup $exe
        if (-not $setup) {
            ClearResume
            Say '  Not installed: permission refused. Your report above is saved all the same.' Yellow
            return 'failed'
        }
        if (-not $setup.installed) {
            ClearResume
            Say "  USBPcap's installer did not finish ($($setup.why))." Red
            return 'failed'
        }
        if (-not $setup.loads) {
            ClearResume
            SayRefused $setup
            return 'refused'
        }
        Say '  USBPcap is installed, and Windows accepts its driver.' Green
        return 'installed'
    } catch {
        ClearResume
        Say "  Not installed: $($_.Exception.Message)" Red
        return 'failed'
    } finally {
        Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# Runs UsbPcapSetupPhase in a window with administrator rights (Windows asks
# first) and waits for it. What it found, or $null if permission was refused.
function UsbPcapSetup([string]$installer) {
    $result = Join-Path ([IO.Path]::GetTempPath()) "SharkDeck-USBPcap-$PID.json"
    Remove-Item -LiteralPath $result -ErrorAction SilentlyContinue
    # The owner, by name: the sign-in task that carries on after the restart is theirs.
    $job = [ordered]@{ installer = $installer; result = $result; user = [Security.Principal.WindowsIdentity]::GetCurrent().Name } | ConvertTo-Json -Compress
    # Base64, so paths with spaces pass through cmd.exe untouched.
    $token = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($job))
    try {
        Start-Process -FilePath $env:ComSpec -ArgumentList ('/c ""' + $env:SD_REPORT_SELF + '" --usbpcap-setup ' + $token + '"') -Verb RunAs -Wait | Out-Null
    } catch { return $null }
    if (-not (Test-Path -LiteralPath $result)) {
        return [pscustomobject]@{ installed = [bool](FindUsbPcap); checked = $false; loads = $false; removed = $false; why = 'its window was closed before the end' }
    }
    $found = [IO.File]::ReadAllText($result) | ConvertFrom-Json
    Remove-Item -LiteralPath $result -ErrorAction SilentlyContinue
    return $found
}

# The part that needs administrator rights, in the window Windows opened with
# them: the sign-in task, the installer (when given one), then the driver,
# loaded once. USBPcap's driver sits on every USB controller and hub, and one
# Windows refuses to load (Memory integrity can) stops every USB device,
# keyboard and mouse included, from the next start. So it is loaded here,
# before anything restarts: when Windows refuses it, a USBPcap this tool just
# installed is taken out again.
function UsbPcapSetupPhase([string]$token) {
    $host.UI.RawUI.WindowTitle = 'Shark Deck - USBPcap'
    $job = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($token)) | ConvertFrom-Json
    $out = [ordered]@{ installed = $false; checked = $false; loads = $false; removed = $false; why = '' }
    Say ''
    Say '  Shark Deck - USBPcap' Cyan
    Say '  ====================' Cyan
    try {
        if (-not (IsAdmin)) { $out.why = 'no administrator rights'; return }
        # First, so that any restart from now on carries on with the recording.
        RegisterResumeTask $job.user
        if ($job.installer) {
            # Checked again, now that it is about to run with administrator rights.
            if ((Get-FileHash -Algorithm SHA256 -LiteralPath $job.installer).Hash -ne $UsbPcapInstallerSha256) { $out.why = 'not the expected file'; return }
            Say '  Installing USBPcap...' Yellow
            Say '  If Windows offers to restart meanwhile, choose Restart Later: this tool restarts the' Yellow
            Say '  computer itself in a moment, once it has checked the driver.' Yellow
            $fenced = $false
            $code = [SdJob]::RunNoRestart($job.installer, '/S', [ref]$fenced)
            if ($code -ne 0 -or -not (FindUsbPcap)) { $out.why = "code $code"; return }
        }
        $out.installed = [bool](FindUsbPcap)
        Say '  Checking that Windows accepts its driver...' Yellow
        $load = UsbPcapLoadCheck
        $out.checked = $true
        $out.loads = $load.loads
        $out.why = $load.why
        if (-not $load.loads -and $job.installer) {
            Say '  Windows refused it: taking USBPcap out again...' Yellow
            $out.removed = RemoveUsbPcap
        }
    } catch {
        $out.why = $_.Exception.Message
    } finally {
        # Nothing to carry on after a restart unless the driver is in place and accepted.
        if (-not $out.loads) { UnregisterResumeTask }
        [IO.File]::WriteAllText($job.result, ($out | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
    }
}

# Loads USBPcap's driver once, the way Windows will when it starts (this needs
# administrator rights): whether Windows accepts it, and if not, what it said.
function UsbPcapLoadCheck {
    $sc = Join-Path $env:SystemRoot 'System32\sc.exe'
    # 'Continue': Windows PowerShell stops on a native program's error output under 'Stop'.
    & { $ErrorActionPreference = 'Continue'; & $sc start USBPcap 2>&1 } | Out-Null
    $code = $LASTEXITCODE
    # 1056: it is running already.
    if ($code -eq 0 -or $code -eq 1056) {
        # Loaded on its own it does nothing: it joins the USB hubs when Windows starts.
        if ($code -eq 0) { & { $ErrorActionPreference = 'Continue'; & $sc stop USBPcap 2>&1 } | Out-Null }
        return [pscustomobject]@{ loads = $true; why = '' }
    }
    return [pscustomobject]@{ loads = $false; why = (New-Object ComponentModel.Win32Exception($code)).Message }
}

# Takes out the USBPcap this tool just installed: its own uninstaller, then a
# check that no USB controller or hub lists it as a filter any more (the entry
# that would stop them at the next start). True once it is gone.
function RemoveUsbPcap {
    $cmd = FindUsbPcap
    if ($cmd) {
        $dir = Split-Path -Parent $cmd
        $uninstaller = Join-Path $dir 'Uninstall.exe'
        if (Test-Path -LiteralPath $uninstaller) {
            # _?= keeps it in place, so waiting for it waits for the uninstall itself.
            Start-Process -FilePath $uninstaller -ArgumentList @('/S', "_?=$dir") -Wait | Out-Null
            if ((Split-Path -Leaf $dir) -eq 'USBPcap') { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue }
        }
    }
    $key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\CurrentControlSet\Control\Class\{36FC9E60-C465-11CF-8056-444553540000}', $true)
    try {
        $filters = [string[]]@($key.GetValue('UpperFilters', [string[]]@()))
        $kept = [string[]]@($filters | Where-Object { $_ -ne 'USBPcap' })
        if ($kept.Count -lt $filters.Count) {
            if ($kept.Count -gt 0) { $key.SetValue('UpperFilters', $kept, [Microsoft.Win32.RegistryValueKind]::MultiString) }
            else { $key.DeleteValue('UpperFilters', $false) }
        }
        return -not (@($key.GetValue('UpperFilters', [string[]]@())) -contains 'USBPcap')
    } finally {
        $key.Close()
    }
}

# What the owner reads when Windows would not load USBPcap's driver.
function SayRefused($check) {
    Say ''
    if (-not $check.checked) {
        Say "  Whether Windows accepts USBPcap's driver was not checked ($($check.why))." Red
        Say '  Run this tool again before restarting the computer: it checks first.' Yellow
        return
    }
    if ($check.removed) {
        Say '  Windows refused USBPcap''s driver, so the tool took USBPcap out again, before any restart.' Red
        Say '  This computer is as it was.' White
    } else {
        Say '  Windows refuses USBPcap''s driver.' Red
        Say '  Before the next restart, uninstall USBPcap (Settings > Apps > USBPcap): a driver Windows' Yellow
        Say '  refuses can stop every USB device, keyboard and mouse included, from the next start.' Yellow
    }
    if ($check.why) { Say "  Windows said: $($check.why)" DarkGray }
    ExplainUsbPcap 'blocked'
}

# The USB controllers USBPcap listens on, as USBPcapCMD lists them: one for each
# root hub it joined when Windows started, none before that restart. USBPcapCMD
# is a Windows (GUI) program, whose output PowerShell neither waits for nor
# reads: it runs here with its output redirected.
function UsbPcapHubs([string]$pcapCmd) {
    if (-not $pcapCmd) { return }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $pcapCmd
    $psi.Arguments = '--extcap-interfaces'
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.CreateNoWindow = $true
    try {
        $p = [System.Diagnostics.Process]::Start($psi)
        $read = $p.StandardOutput.ReadToEndAsync()
        if (-not $p.WaitForExit(15000)) { try { $p.Kill() } catch { }; return }
        foreach ($m in [regex]::Matches($read.Result, 'interface \{value=([^}]+)\}')) { $m.Groups[1].Value }
    } catch { }
}

# True when USBPcap was installed after Windows last started (fully: a "Shut
# down" with fast startup does not count): its driver joins the USB hubs only
# then. Its files keep their 2020 dates, so the install time comes from
# Windows' own log.
function UsbPcapNeedsRestart {
    $boot = (Get-CimInstance -ClassName Win32_OperatingSystem).LastBootUpTime
    try {
        return @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = 7045; StartTime = $boot } -ErrorAction Stop | Where-Object { $_.Message -match 'USBPcap' }).Count -gt 0
    } catch { return $false }
}

# Why USBPcap lists no USB controller: 'missing', 'blocked', 'restart' or 'broken'.
# The Code Integrity log needs administrator rights.
function UsbPcapTrouble {
    if (-not (FindUsbPcap) -or (UsbPcapDriver) -eq 'missing') { return 'missing' }
    $boot = (Get-CimInstance -ClassName Win32_OperatingSystem).LastBootUpTime
    try {
        $refused = @(Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-CodeIntegrity/Operational'; StartTime = $boot; Level = 2, 3 } -ErrorAction Stop | Where-Object { $_.Message -match 'USBPcap' })
        if ($refused.Count -gt 0) { return 'blocked' }
    } catch { }
    if (UsbPcapNeedsRestart) { return 'restart' }
    return 'broken'
}

function ResumeFile { Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'SharkDeck\device-report-resume.json' }

# What a recording interrupted by a restart carries on from.
function SaveResume($state) {
    $file = ResumeFile
    New-Item -ItemType Directory -Path (Split-Path -Parent $file) -Force | Out-Null
    [IO.File]::WriteAllText($file, ($state | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding($false)))
}

# After a restart, Windows opens the tool again when its owner signs in: a task
# that runs at sign-in only (Windows' run-once list can be run at any moment by
# an installer, and once was, in the middle of the restart countdown), with the
# administrator rights a recording needs, so no question is asked then. It waits
# 30 seconds, for the programs that start with Windows. Setting it needs
# administrator rights.
function RegisterResumeTask([string]$user) {
    if (-not $user) { $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name }
    $action = New-ScheduledTaskAction -Execute $env:ComSpec -Argument ('/c ""' + $env:SD_REPORT_SELF + '" --resume-recording"')
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $trigger.Delay = 'PT30S'
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $ResumeName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
}

function UnregisterResumeTask {
    try { Unregister-ScheduledTask -TaskName $ResumeName -Confirm:$false -ErrorAction Stop } catch { }
}

# Nothing left to carry on. Without administrator rights the task stays, and
# deletes itself at the next sign-in, finding nothing to carry on.
function ClearResume {
    Remove-Item -LiteralPath (ResumeFile) -ErrorAction SilentlyContinue
    UnregisterResumeTask
}

function RestartForUsbPcap {
    Say ''
    Say '  USBPcap starts listening when Windows starts, so the computer needs a restart. Sign in' White
    Say '  as usual afterwards: the recording opens by itself.' White
    Say '  Save your work in other programs first.' Yellow
    $a = Read-Host '  Restart now? [Y/n]'
    if ($a -match '^\s*[nN]') {
        Say '  Restart whenever you are ready (Start > Power > Restart, not Shut down): the recording' White
        Say '  opens by itself after it.' White
        return
    }
    & shutdown.exe /r /t 10 /c 'Shark Deck: restarting so that USBPcap can start.' | Out-Null
    Say '  Restarting in 10 seconds...' Cyan
}

# A recording set aside for a restart: true when one was carried on (or refused).
function ResumeRecording([bool]$asked) {
    $file = ResumeFile
    if (-not (Test-Path -LiteralPath $file)) { return $false }
    $state = [IO.File]::ReadAllText($file) | ConvertFrom-Json
    if (-not $asked) {
        Say ''
        Say "  You started a recording$(if ($state.report.model) { " of the $($state.report.model)" }) before a restart." White
        $a = Read-Host '  Carry on with it now? [Y/n]'
        if ($a -match '^\s*[nN]') { ClearResume; return $false }
    }
    # The recording window clears what is saved once USBPcap is listening.
    [void](StartRecording $state)
    return $true
}

# Shark Deck talks to the devices it knows. Running during a report or a
# recording (it starts with Windows), it would answer in the device's place,
# or talk over the official software: it is closed first.
function CloseSharkDeck {
    $running = @(Get-Process -Name 'SharkDeck' -ErrorAction SilentlyContinue)
    if ($running.Count -eq 0) { return }
    Say ''
    Say '  Shark Deck is running (it starts with Windows). It talks to the device too, so it has to' Yellow
    Say '  be closed while this tool works.' Yellow
    $a = Read-Host '  Close Shark Deck now? [Y/n]'
    if ($a -match '^\s*[nN]') {
        Say '  Then quit it yourself (its icon next to the clock: right-click > Quit).' White
        [void](Read-Host '  Press Enter once it is closed')
        return
    }
    foreach ($p in $running) { try { $p.Kill() } catch { } }
    foreach ($p in $running) { try { [void]$p.WaitForExit(5000) } catch { } }
    Say '  Shark Deck is closed. It opens again from the Start menu, or with Windows.' DarkGray
}

function PresentPaths([string[]]$devices) {
    @([SdHid]::Paths() | Where-Object { $p = $_; @($devices | Where-Object { $p -match ('vid_{0}&pid_{1}' -f ($_ -split ':')) }).Count -gt 0 })
}

# What to keep private, from Windows' description of each interface: what is
# typed on a keyboard collection is blanked, a mouse collection's movement cut
# to a sample. Set before recording, so typing is blanked as it is recorded.
function SetPrivacyRules($interfaces) {
    foreach ($i in @($interfaces)) {
        if (-not $i) { continue }
        $mi = if ($i.Path -match 'mi_([0-9a-f]{2})') { [Convert]::ToInt32($Matches[1], 16) } else { 0 }
        $ids = [int[]]@($i.InputIds | Where-Object { $_ -ne 0 })
        $device = '{0:X4}:{1:X4}' -f $i.Vid, $i.Pid
        if ($i.UsagePage -eq 1 -and $i.Usage -eq 6) { [SdPcap]::AddRule($device, $mi, 'keyboard', $ids) }
        elseif ($i.UsagePage -eq 1 -and $i.Usage -eq 2) { [SdPcap]::AddRule($device, $mi, 'mouse', $ids) }
    }
}

function HidePrivatePath([string]$path) { if (-not $path) { return $path }; $path -replace '^[A-Za-z]:\\Users\\[^\\]+', '%USERPROFILE%' }

function Pack([string]$dir, [string]$zip) {
    if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
    # Not Compress-Archive: Windows PowerShell's writes backslashes into entry names.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($dir, $zip, [IO.Compression.CompressionLevel]::Optimal, $false)
}

# The second half, in the window Windows opened with administrator rights.
function RecordingPhase([string]$token) {
    $host.UI.RawUI.WindowTitle = 'Shark Deck - recording'
    $statePath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($token))
    $state = [IO.File]::ReadAllText($statePath) | ConvertFrom-Json
    [SdShot]::DpiAware()
    Say ''
    Say '  Shark Deck - recording' Cyan
    Say '  ======================' Cyan
    if (-not (IsAdmin)) { Say '  This part needs administrator rights.' Red; [void](Read-Host '  Press Enter to close'); return }

    $pcapCmd = FindUsbPcap
    $hubs = @(UsbPcapHubs $pcapCmd)
    if ($hubs.Count -eq 0) {
        # Not listening yet: say why, and restart for it when that is the cure.
        $trouble = UsbPcapTrouble
        if ($trouble -ne 'restart') { ExplainUsbPcap $trouble }
        else {
            $load = UsbPcapLoadCheck
            if (-not $load.loads) { SayRefused ([pscustomobject]@{ checked = $true; removed = $false; why = $load.why }) }
            else {
                SaveResume $state
                RegisterResumeTask ''
                Say ''
                Say '  USBPcap is installed, but the computer has not restarted (fully) since.' White
                RestartForUsbPcap
            }
        }
        [void](Read-Host '  Press Enter to close')
        return
    }
    # USBPcap is listening: nothing left to carry on after a restart.
    ClearResume

    $devices = @($state.report.devices)
    $targets = New-Object System.Collections.Generic.List[string]
    foreach ($d in $devices) { $targets.Add("$($d.vid):$($d.pid)") }
    # Known already: from Shark Deck (--kind), else from how it is connected.
    # Asked only when neither tells.
    $kind = if ($state.kind) { [string]$state.kind } else { KindOf $devices }
    $guess = switch (FirstInterfaceKind $devices) { 'keyboard' { 'K' } 'mouse' { 'M' } default { '' } }
    while (-not $kind) {
        $a = (Read-Host ('  Is it a mouse (M) or a keyboard (K)?' + $(if ($guess) { " [$guess]" } else { '' }))).Trim()
        if (-not $a) { $a = $guess }
        if ($a -match '^[mMsS]') { $kind = 'mouse' } elseif ($a -match '^[kKcCtT]') { $kind = 'keyboard' }
    }

    CloseSharkDeck
    Say ''
    Say '  Close the official software, if it is open.' White
    [void](Read-Host '  Press Enter once it is closed')

    # Where the device is plugged in, to record it right there: unplugged and
    # plugged back in, a keyboard can take a while to type normally again. Only
    # when that place cannot be worked out is it unplugged, and recorded from the
    # moment it comes back.
    $place = $null
    $atHub = $null
    foreach ($path in @(PresentPaths $targets.ToArray())) {
        $i = [SdHid]::Describe($path)
        try { $place = [SdUsb]::Locate($path, $i.Vid, $i.Pid) } catch { $place = $null }
        if ($place) { break }
    }
    if ($place) { foreach ($hub in $hubs) { if ([SdUsb]::SameHub([SdUsb]::UsbPcapRootHub($hub), $place.RootHub)) { $atHub = $hub } } }
    $replug = -not $atHub
    if ($replug) {
        Say '  Unplug the device (or its receiver).' White
        $deadline = (Get-Date).AddMinutes(3)
        while ((PresentPaths $targets.ToArray()).Count -gt 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 400 }
        if ((PresentPaths $targets.ToArray()).Count -gt 0) { Say '  It is still plugged in. Run the tool again when you are ready.' Red; [void](Read-Host '  Press Enter to close'); return }
        Say '  Unplugged.' Cyan
    }

    $stamp = Get-Date -Format 'yyyyMMdd-HHmm'
    $work = Join-Path ([IO.Path]::GetTempPath()) "SharkDeck-recording-$stamp-$PID"
    New-Item -ItemType Directory -Path $work -Force | Out-Null
    $pcaps = New-Object System.Collections.Generic.List[string]
    $recorders = New-Object System.Collections.Generic.List[SdRecorder]
    $plugged = @()
    [SdPcap]::ClearRules()
    SetPrivacyRules @(PresentPaths $targets.ToArray() | ForEach-Object { [SdHid]::Describe($_) })
    try {
        # One recorder per USB controller. Each keeps what is plugged in from now
        # on; the device's own controller also keeps the device, by its address,
        # its descriptors written in first (it gave them when it was plugged in).
        # Nothing else already connected: not the keyboard you type with.
        foreach ($hub in $hubs) {
            $file = Join-Path $work (($hub -replace '[^A-Za-z0-9]', '') + '.pcap')
            $pcaps.Add($file)
            # Its capture comes through its standard output ("-o -"): USBPcapCMD
            # locks a file it writes to, and the step window counts what arrives.
            $cmdArgs = @('-d', $hub, '-o', '-', '--capture-from-new-devices', '-b', '8388608')
            if ($hub -eq $atHub) { $cmdArgs += @('--devices', [string]$place.Address, '--inject-descriptors') }
            $r = New-Object SdRecorder($pcapCmd, ($cmdArgs -join ' '), $file)
            [void][SdJob]::Adopt($r.Process)
            $recorders.Add($r)
        }
        Start-Sleep -Milliseconds 1500
        if (@($recorders | Where-Object { -not $_.Process.HasExited }).Count -eq 0) {
            Say '  USBPcap could not start recording. Restart the computer, then run this tool again.' Red
            [void](Read-Host '  Press Enter to close')
            return
        }

        if ($replug) {
            Say '  Plug it back in.' White
            $paths = @(WaitForDevice -Minutes 3)
            if ($paths.Count -eq 0) { Say '  Nothing was plugged in. Run the tool again when you are ready.' Red; [void](Read-Host '  Press Enter to close'); return }
            $plugged = @($paths | ForEach-Object { [SdHid]::Describe($_) })
            foreach ($i in $plugged) { $n = '{0:X4}:{1:X4}' -f $i.Vid, $i.Pid; if (-not $targets.Contains($n)) { $targets.Add($n) } }
            SetPrivacyRules $plugged
            Start-Sleep -Seconds 3
        } else {
            Start-Sleep -Seconds 1
        }
        $size = 0; foreach ($f in $pcaps) { if (Test-Path -LiteralPath $f) { $size += (Get-Item -LiteralPath $f).Length } }
        if ($size -le 24 * $pcaps.Count) {
            Say '  USBPcap has recorded nothing from it so far.' Yellow
            Say '  Plugging it straight into the computer (not into a hub, a dock or a monitor) often helps.' DarkGray
            $a = Read-Host '  Go on anyway? [y/N]'
            if ($a -notmatch '^\s*[yYoO]') { return }
        }

        # Shark Deck starts with Windows, maybe since the question above: closed again if so.
        CloseSharkDeck
        $first = $devices[0]
        $recDir = Join-Path $state.outDir ('SharkDeck-recording-{0}-{1}-{2}' -f $first.vid, $first.pid, $stamp)
        New-Item -ItemType Directory -Path $recDir -Force | Out-Null
        Say ''
        Say '  A small window now walks you through the official software, one setting at a time.' White
        Say '  It stays on top of the others. Keep this window open until the end.' DarkGray
        [System.Windows.Forms.Application]::EnableVisualStyles()
        $vids = [int[]]@($targets | ForEach-Object { [Convert]::ToInt32(($_ -split ':')[0], 16) } | Select-Object -Unique)
        $table = if ($state.steps) { StepTableFor $state.steps } elseif ($state.custom) { $CustomStepTable } else { $StepTable }
        $wizard = [SdWizard]::new((StepList $kind $table), (Join-Path $recDir 'screens'), (Join-Path $recDir 'attach'), $pcaps.ToArray(), $vids, [string[]]@([SdHid]::Paths()))
        $wizard.DeviceName = $(if ($state.report.model) { $state.report.model } elseif ($first.product) { $first.product } else { 'device' })
        $wizard.Keyboard = $kind -eq 'keyboard'
        $wizard.Recorders = $recorders.ToArray()
        $where = WhereFor $kind
        foreach ($g in $where.Keys) { $wizard.Where[$g] = $where[$g] }
        $started = (Get-Date).ToUniversalTime()
        [void][System.Windows.Forms.Application]::Run($wizard)
        $ended = (Get-Date).ToUniversalTime()
    } finally {
        foreach ($r in $recorders) {
            try { if (-not $r.Process.HasExited) { $r.Process.Kill(); [void]$r.Process.WaitForExit(5000) } } catch { }
            $r.Finish()
        }
    }

    Say ''
    Say '  Recording stopped. Keeping only your device''s part of it...' Cyan
    # Keep it private, once more with everything now known (a connection
    # plugged in during the recording included): typing blanked, and what was
    # blanked while recording stays blank; mouse movement cut to a sample.
    $described = New-Object System.Collections.Generic.List[SdHidInterface]
    foreach ($p in [SdHid]::Paths()) { $i = [SdHid]::Describe($p); if ($targets.Contains(('{0:X4}:{1:X4}' -f $i.Vid, $i.Pid))) { $described.Add($i) } }
    foreach ($i in $wizard.NewInterfaces) { $described.Add($i); $n = '{0:X4}:{1:X4}' -f $i.Vid, $i.Pid; if (-not $targets.Contains($n)) { $targets.Add($n) } }
    foreach ($i in $plugged) { $described.Add($i) }
    [SdPcap]::ClearRules()
    SetPrivacyRules $described
    $filtered = [SdPcap]::Filter($pcaps.ToArray(), (Join-Path $recDir 'capture.pcap'), $targets.ToArray())
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue

    $software = [ordered]@{ process = $wizard.SoftwareName; window = $wizard.SoftwareTitle }
    if ($wizard.SoftwarePath -and (Test-Path -LiteralPath $wizard.SoftwarePath)) {
        $info = (Get-Item -LiteralPath $wizard.SoftwarePath).VersionInfo
        $software.file = Split-Path -Leaf $wizard.SoftwarePath
        $software.folder = HidePrivatePath (Split-Path -Parent $wizard.SoftwarePath)
        $software.product = $info.ProductName
        $software.company = $info.CompanyName
        $software.version = $info.FileVersion
        $software.sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $wizard.SoftwarePath).Hash
    }
    $steps = @($wizard.Results | ForEach-Object {
        [ordered]@{ id = $_.Id; group = $_.Group; text = $_.Text; value = $_.Value; series = $_.Series; status = $_.Status; attempt = $_.Attempt; note = $_.Note; start = $_.Start; end = $_.End; shots = @($_.Shots) }
    })
    $recording = [ordered]@{
        version = 1
        kind = $kind
        usbpcap = (Get-Item -LiteralPath $pcapCmd).VersionInfo.FileVersion
        started = $started.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        ended = $ended.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        finishedAllSteps = $wizard.FinishedAll
        inPlace = -not $replug
        devices = $targets.ToArray()
        software = $software
        kept = [ordered]@{ messages = $filtered.Kept; otherDevices = $filtered.Dropped; keyPressesBlanked = $filtered.KeyboardBlanked; mouseMovesLeftOut = $filtered.MouseThinned; serialNumbersBlanked = $filtered.SerialBlanked; unidentified = $filtered.Unidentified; seen = @($filtered.Devices) }
        steps = $steps
    }
    $report = $state.report
    $report | Add-Member -NotePropertyName recording -NotePropertyValue $recording -Force

    $done = @($steps | Where-Object { $_.status -eq 'done' }).Count
    $notOffered = @($steps | Where-Object { $_.status -eq 'not-offered' }).Count
    $skipped = @($steps | Where-Object { $_.status -eq 'skipped' }).Count
    $shots = @($steps | ForEach-Object { @($_.shots) }).Count
    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($l in @($state.readable)) { $lines.Add($l) }
    $lines.Add('')
    $lines.Add('Recording')
    $lines.Add('---------')
    $lines.Add("A $kind, recorded $($recording.started) to $($recording.ended) with USBPcap $($recording.usbpcap).")
    if (-not $replug) { $lines.Add("Recorded where it was plugged in (USB address $($place.Address)), without unplugging it: USBPcap wrote in its device and configuration descriptors.") }
    if ($software.process) { $lines.Add("Official software: $($software.process)" + $(if ($software.Contains('product') -and $software.product) { " ($($software.product) $($software.version))" } else { '' }) + '.') }
    $lines.Add("Kept $($filtered.Kept) USB messages from $(@($filtered.Devices) -join ', '); key presses blanked: $($filtered.KeyboardBlanked); mouse movements left out: $($filtered.MouseThinned).")
    if (@($filtered.Devices).Count -eq 0) { $lines.Add("USBPcap recorded no device descriptor, so nothing could be kept ($($filtered.Unidentified) messages from an unnamed device were left out).") }
    $lines.Add("Steps: $done done, $notOffered not in the software, $skipped skipped. Pictures: $shots (folder `"screens`").")
    $lines.Add('')
    $lines.Add('----- For the Shark Deck maintainer: keep everything below exactly as it is -----')
    $lines.Add(($report | ConvertTo-Json -Depth 12 -Compress))
    SaveText (Join-Path $recDir 'report.txt') $lines.ToArray()
    Remove-Item -LiteralPath $statePath -ErrorAction SilentlyContinue

    Say ''
    if (@($filtered.Devices).Count -eq 0) {
        Say '  The recording holds nothing from your device: USBPcap never saw it introduce itself.' Red
        Say '  Plug it straight into the computer (not into a hub, a dock or a monitor) and record again.' White
    }
    Say "  Steps: $done done, $notOffered not in the software, $skipped skipped. Pictures: $shots." Green
    $still = @($wizard.StillChanged())
    Say ''
    if ($still.Count) {
        Say '  Still changed on your device: put these back in the official software.' Yellow
        foreach ($c in $still) { Say "    - $c" Yellow }
    } else {
        Say '  Everything the steps changed was put back.' DarkGray
    }
    # Packed now, so the .zip is there even if this window is closed.
    $zip = "$recDir.zip"
    Pack $recDir $zip
    Say ''
    Say "  Ready to send: $zip" Green
    # One window: the folder that holds the .zip (and, beside it, its files
    # unpacked), the .zip selected, ready to drag onto the issue.
    Start-Process explorer.exe "/select,`"$zip`""
    # Where it goes, asked in a window of its own: the console is easy to miss
    # behind the folder that just opened.
    $send = [SdWizard]::AskToSend((Split-Path $zip -Leaf), $wizard.DeviceName, $wizard.Keyboard)
    # A picture deleted from the folder meanwhile leaves the .zip too.
    Pack $recDir $zip
    Say ''
    Say "  Recording saved: $zip" Green
    Say ''
    switch ($send) {
        'new' {
            Start-Process $IssueUrl
            Say '  On the page that opened: fill it in, then drag the .zip onto it.' White
        }
        'existing' {
            Start-Process $IssuesUrl
            Say '  On the page that opened: open the issue about your device, then drag the .zip onto a comment.' White
        }
        default {
            Say '  To send it later: open a "New device" request on GitHub and attach that .zip file:' White
            Say "  $IssueUrl" Cyan
        }
    }
    Say '  (USBPcap stays installed. To remove it: Settings > Apps > USBPcap, then restart.)' DarkGray
    Say ''
    [void](Read-Host '  Press Enter to close this window')
}

# ---- Main ------------------------------------------------------------------------
$flags = ReadFlags $env:SD_REPORT_ARGS
if ($flags.SetupOf) { UsbPcapSetupPhase $flags.SetupOf; exit 0 }
if ($flags.RecordingOf) { RecordingPhase $flags.RecordingOf; exit 0 }
if ($flags.Preview) {
    # The steps as an owner sees them; no device is involved and nothing is recorded.
    [SdShot]::DpiAware()
    [System.Windows.Forms.Application]::EnableVisualStyles()
    $kind = if ($flags.Preview -eq 'keyboard') { 'keyboard' } else { 'mouse' }
    # Only the steps asked for (--steps), as an owner's recording would walk them.
    $table = if ($flags.Steps) { StepTableFor $flags.Steps } else { $StepTable }
    $preview = [SdWizard]::new((StepList $kind $table), $env:TEMP, $env:TEMP, [string[]]@(), [int[]]@(), [string[]]@())
    $preview.Preview = $true
    $where = WhereFor $kind
    foreach ($g in $where.Keys) { $preview.Where[$g] = $where[$g] }
    [void][System.Windows.Forms.Application]::Run($preview)
    $preview.Results | ForEach-Object { Say ('  {0,-22} {1,-12} {2}' -f $_.Id, $_.Status, $_.Note) }
    exit 0
}
$interactive = -not ($flags.Device -or $flags.AllKnown)
if ($flags.Resume -and -not (Test-Path -LiteralPath (ResumeFile))) {
    # Opened at sign-in for a recording already under way, or given up: nothing to do.
    UnregisterResumeTask
    exit 0
}

Say ''
Say '  Shark Deck - device report' Cyan
Say '  ===========================' Cyan
if ($flags.Resume -or ($interactive -and -not $flags.NoRecord -and (Test-Path -LiteralPath (ResumeFile)))) {
    if ($flags.Resume) { Say '  Welcome back: carrying on with the recording.' Green }
    if (ResumeRecording $flags.Resume) {
        Say ''
        [void](Read-Host '  Press Enter to close this window')
        exit 0
    }
}
Say '  This collects what Shark Deck needs to support your mouse or keyboard: how the device'
Say '  describes itself, then a recording of the official software talking to it (about 30'
Say '  minutes). It changes nothing on the device and sends nothing anywhere.'
Say ''
Say '  Close Shark Deck and the Attack Shark software first, if they are running.' Yellow
if ($interactive) { CloseSharkDeck }

$chosen = $null
if ($flags.Device) {
    $want = $flags.Device.ToUpperInvariant() -split ':'
    if ($want.Count -ne 2) { throw "--device takes VID:PID in hex, like 1D57:FA55" }
    $wantVid = [Convert]::ToInt32($want[0], 16); $wantPid = [Convert]::ToInt32($want[1], 16)
    $found = @([SdHid]::Paths() | ForEach-Object { [SdHid]::Describe($_) } | Where-Object { $_.Vid -eq $wantVid -and $_.Pid -eq $wantPid })
} elseif ($flags.AllKnown) {
    $found = @([SdHid]::Paths() | ForEach-Object { [SdHid]::Describe($_) } | Where-Object { $KnownVendorIds -contains $_.Vid })
} else {
    $chosen = ChooseDevice
    $found = @($chosen.Paths | ForEach-Object { [SdHid]::Describe($_) })
}

if ($found.Count -eq 0) {
    Say ''
    Say '  No device was found.' Red
    if ($interactive) {
        Say '  Try another USB port, or a cable instead of the receiver, then run this again.'
        [void](Read-Host '  Press Enter to close')
    }
    exit 1
}

$model = ''
if ($interactive) {
    Say ''
    if ($chosen -and $chosen.Model) {
        # The name the device gave when it was found, which the owner just confirmed.
        $model = $chosen.Model
        Say "  Model: $model" White
    } else {
        $named = @($found | Where-Object { $_.Product } | ForEach-Object { $_.Product })
        $default = if ($named.Count) { $named[0] } else { '' }
        $typed = (Read-Host ('  Its model name, as on the box or the store page' + $(if ($default) { " [$default]" } else { ' (for example: X11)' }))).Trim()
        $model = if ($typed) { $typed } else { $default }
    }
}

$devices = @()
foreach ($group in ($found | Group-Object { '{0:X4}:{1:X4}' -f $_.Vid, $_.Pid })) {
    $first = $group.Group[0]
    $family = FamilyOf $first.Vid
    $named = @($group.Group | Where-Object { $_.Product }) + @($group.Group)
    $device = [ordered]@{
        vid = Hex4 $first.Vid
        pid = Hex4 $first.Pid
        release = Hex4 $first.Release
        product = $named[0].Product
        manufacturer = $named[0].Manufacturer
        reportsSerial = [bool]($group.Group | Where-Object { $_.HasSerial })
        family = $family
        interfaces = @($group.Group | Sort-Object UsagePage, Usage | ForEach-Object {
            $mi = if ($_.Path -match 'mi_([0-9a-f]{2})') { [Convert]::ToInt32($Matches[1], 16) } else { $null }
            [ordered]@{
                interface = $mi
                usagePage = Hex4 $_.UsagePage
                usage = Hex4 $_.Usage
                kind = UsageName $_.UsagePage $_.Usage
                inputBytes = $_.InputBytes
                outputBytes = $_.OutputBytes
                featureBytes = $_.FeatureBytes
                inputIds = @($_.InputIds)
                outputIds = @($_.OutputIds)
                featureIds = @($_.FeatureIds)
                error = $_.Error
            }
        })
        identify = $null
    }
    if ($flags.NoQuery) {
        $device.identify = [ordered]@{ asked = $false; why = 'Not asked (--no-query).' }
    } else {
        if ($family -eq 'royuan' -or $family -eq 'compx-hub') { Say "  Asking $($device.vid):$($device.pid) which model it is (read-only)..." DarkGray }
        try { $device.identify = AskModel $family $first.Pid $group.Group }
        catch { $device.identify = [ordered]@{ asked = $true; reply = $null; why = $_.Exception.Message } }
    }
    $devices += $device
}

$report = [ordered]@{
    tool = 'SharkDeck-device-report'
    version = $ToolVersion
    created = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    windows = [Environment]::OSVersion.Version.ToString()
    model = $model
    devices = $devices
}

# ---- The report: readable on top, exact underneath -------------------------------
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add('Shark Deck device report')
$lines.Add('========================')
$lines.Add("Created $($report.created) on Windows $($report.windows), tool version $ToolVersion.")
if ($model) { $lines.Add("Model, as typed: $model") }
foreach ($d in $devices) {
    $lines.Add('')
    $name = if ($d.product) { " `"$($d.product)`"" } else { '' }
    $maker = if ($d.manufacturer) { " by `"$($d.manufacturer)`"" } else { '' }
    $lines.Add("Device $($d.vid):$($d.pid)$name$maker - release $($d.release) - reports a serial number: $(if ($d.reportsSerial) { 'yes' } else { 'no' })")
    $lines.Add("  Family: $(FamilyText $d.family)")
    foreach ($i in $d.interfaces) {
        $ids = @()
        if ($i.inputIds.Count) { $ids += "in $($i.inputIds -join ',')" }
        if ($i.outputIds.Count) { $ids += "out $($i.outputIds -join ',')" }
        if ($i.featureIds.Count) { $ids += "feature $($i.featureIds -join ',')" }
        $at = if ($null -ne $i.interface) { "interface $($i.interface), " } else { '' }
        $lines.Add("  - $at" + "usage $($i.usagePage):$($i.usage) ($($i.kind)): input $($i.inputBytes), output $($i.outputBytes), feature $($i.featureBytes) bytes" + $(if ($ids.Count) { "; report ids $($ids -join '; ')" } else { '' }) + $(if ($i.error) { " [$($i.error)]" } else { '' }))
    }
    $id = $d.identify
    if ($id.asked -and $id.Contains('modelId')) { $lines.Add("  Model question (0x8F): model id $($id.modelId), firmware $($id.firmware).") }
    elseif ($id.asked -and $id.Contains('mid')) { $lines.Add("  Model question (0x01): vendor $($id.cid), model number (mid) $($id.mid), link $($id.link).") }
    elseif ($id.asked) { $lines.Add("  Model question: no answer. $($id.why)") }
    else { $lines.Add("  Model question: $($id.why)") }
}
$readable = $lines.ToArray()
$lines.Add('')
$lines.Add('----- For the Shark Deck maintainer: keep everything below exactly as it is -----')
$lines.Add(($report | ConvertTo-Json -Depth 8 -Compress))

$outDir = if ($flags.Out) { $flags.Out } else { [Environment]::GetFolderPath('Desktop') }
if (-not (Test-Path -LiteralPath $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }
$first = $devices[0]
$file = Join-Path $outDir ("SharkDeck-device-report-{0}-{1}-{2}.txt" -f $first.vid, $first.pid, (Get-Date -Format 'yyyyMMdd-HHmm'))

Say ''
foreach ($l in $readable) { Say "  $l" }

$recording = 'declined'
if (-not $flags.NoRecord -and ($interactive -or $flags.Record)) {
    $recording = OfferRecording $report $readable $file $outDir $flags.Record $flags.Steps $flags.Kind
}

# The report goes into the recording's .zip; it is saved on its own only when
# there is no recording to carry it.
if ($recording -eq 'started' -or $recording -eq 'restart') {
    if ($interactive) { Say ''; [void](Read-Host '  Press Enter to close this window') }
    exit 0
}
SaveText $file $lines.ToArray()
Say ''
Say "  Report saved: $file" Green
if ($interactive) {
    Start-Process explorer.exe "/select,`"$file`""
    Say ''
    Say '  Next: open a "New device" request on GitHub and attach that file:' White
    Say "  $IssueUrl" Cyan
    Say ''
    $go = Read-Host '  Press Enter to open that page in your browser, or close this window'
    if ($null -ne $go) { Start-Process $IssueUrl }
}
exit 0
