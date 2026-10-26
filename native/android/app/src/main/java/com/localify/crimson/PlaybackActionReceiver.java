package com.localify.crimson;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public final class PlaybackActionReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent != null) PlaybackNotificationPlugin.dispatchAction(context, intent.getAction());
    }
}
