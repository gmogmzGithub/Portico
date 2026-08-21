// PORTICO-105: never-block relocation banner.
//
// When the launch-time location guard couldn't move the app into a blessed
// Applications folder (user declined, or no admin rights and both /Applications
// and ~/Applications were unwritable), the app still runs -- but auto-updates are
// off. This surfaces a dismissable banner with an action to re-offer the move.
//
// Layer: Electron Shell (renderer chrome of the main window).

async function initAppLocationBanner() {
  try {
    const status = await window.electronAPI.getAppLocationStatus();
    if (!status || status.needsRelocateBanner !== true) {
      return;
    }
    if (sessionStorage.getItem("porticoLocationBannerDismissed") === "1") {
      return;
    }

    const banner = document.getElementById("app-location-banner");
    if (!banner) return;
    banner.classList.add("visible");

    const moveBtn = document.getElementById("app-location-banner-move");
    if (moveBtn) {
      moveBtn.onclick = async () => {
        // Briefly disable to prevent double-fire, but always re-enable: the
        // relocate offer is fire-and-forget and may not relaunch (user declines
        // / move fails), so the button must stay usable for a retry.
        moveBtn.disabled = true;
        try {
          await window.electronAPI.offerAppRelocation();
        } catch (error) {
          console.error("[LocationBanner] relocation offer failed:", error);
        } finally {
          moveBtn.disabled = false;
        }
      };
    }

    const dismissBtn = document.getElementById("app-location-banner-dismiss");
    if (dismissBtn) {
      dismissBtn.onclick = () => {
        banner.classList.remove("visible");
        try {
          sessionStorage.setItem("porticoLocationBannerDismissed", "1");
        } catch {
          // sessionStorage unavailable -> banner just won't persist dismissal
        }
      };
    }
  } catch (error) {
    console.error("[LocationBanner] Failed to initialize:", error);
  }
}

window.initAppLocationBanner = initAppLocationBanner;
