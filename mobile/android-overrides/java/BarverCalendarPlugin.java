package party.clubiq.barverdarts;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.provider.CalendarContract;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "BarverCalendar")
public class BarverCalendarPlugin extends Plugin {
    @PluginMethod
    public void addEvent(PluginCall call) {
        Long begin = call.getLong("begin"), end = call.getLong("end");
        String title = call.getString("title", ""), location = call.getString("location", "");
        if (begin == null || end == null || begin <= 0 || end <= begin || end - begin > 86400000L || title.isEmpty() || title.length() > 500 || location.length() > 1000) {
            call.reject("Ungültiger Termin");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_INSERT)
            .setData(CalendarContract.Events.CONTENT_URI)
            .putExtra(CalendarContract.Events.TITLE, title)
            .putExtra(CalendarContract.Events.EVENT_LOCATION, location)
            .putExtra(CalendarContract.Events.DESCRIPTION, call.getString("description", "Barver Darts"))
            .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, begin.longValue())
            .putExtra(CalendarContract.EXTRA_EVENT_END_TIME, end.longValue());
        // The calendar app shows its editor; no calendar read/write permission is needed.
        getActivity().runOnUiThread(() -> {
            try { getActivity().startActivity(intent); call.resolve(); }
            catch (ActivityNotFoundException error) { call.reject("Kein Kalender verfügbar"); }
            catch (SecurityException error) { call.reject("Kalender konnte nicht geöffnet werden"); }
        });
    }
}
