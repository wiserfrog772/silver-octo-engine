package com.localify.crimson;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(YtDlpPlugin.class);
        registerPlugin(PlaybackNotificationPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
