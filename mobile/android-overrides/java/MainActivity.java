package party.clubiq.barverdarts;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BarverCalendarPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
