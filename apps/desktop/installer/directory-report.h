// Directory replacement failures retain the original Windows error and the independent restoration outcome.
#pragma once
#include "extract-report.h"

namespace directory_report {

inline std::wstring Compose(DWORD error, LPCWSTR source, LPCWSTR destination, DWORD restoreError, LPCWSTR backup, const std::wstring& attempts) {
    const std::wstring operation = *destination ? L"MoveFileExW" : L"RemoveDirectoryW";
    std::wstring report = L"Operation: " + operation + L"\r\nWindows error: " + std::to_wstring(error)
        + L" (" + extract_report::Win32Message(error) + L")\r\nSource: " + source
        + L"\r\nDestination: " + destination + L"\r\nRestoration error: " + std::to_wstring(restoreError);
    if (restoreError) report += L" (" + extract_report::Win32Message(restoreError) + L")\r\nPreserved backup: " + backup;
    report += L"\r\nTime: " + extract_report::Timestamp() + L"\r\nWindows: " + extract_report::WindowsVersion()
        + L"\r\nAttempts:\r\n" + attempts;
    return report;
}

}
