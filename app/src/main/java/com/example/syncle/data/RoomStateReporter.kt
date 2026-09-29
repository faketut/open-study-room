package com.example.syncle.data

import androidx.compose.ui.geometry.Offset
import com.example.syncle.BuildConfig
import com.example.syncle.domain.SyncleLog
import com.example.syncle.domain.ZonePresence
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Periodically pushes the local participant's `(tableId, x, y)` to the Syncle
 * backend so late joiners receive a recent snapshot. Bearer-authenticated with
 * the LiveKit JWT the server itself signed; the backend verifies the token
 * matches `userId` and the requested room.
 *
 * Lossy at-most-once semantics intentionally: skipping a tick is fine, we will
 * upload the next one. No retry queue.
 */
class RoomStateReporter(
    private val backendUrl: String = BuildConfig.SYNCLE_BACKEND_URL,
    private val client: OkHttpClient = defaultClient,
) {
    /**
     * Posts the local participant's state. Returns the HTTP status code, or
     * `null` if the request failed before getting a response (network error,
     * empty backend URL, etc.). Callers can treat `401` specially to trigger a
     * session-token refresh.
     *
     * `zoneId` is the containing zone's id (null when in no zone) and
     * `zoneKind` the client-computed kind (`silent|discussion|rest|none`;
     * defaults to `"none"` until Android models zones in its map config).
     */
    suspend fun report(
        room: String,
        userId: String,
        token: String,
        tableId: String?,
        position: Offset,
        zoneId: String? = null,
        zoneKind: String = ZonePresence.ZoneKind.NONE.wireValue,
    ): Int? =
        withContext(Dispatchers.IO) {
            val base = backendUrl.trim().trimEnd('/').ifEmpty { return@withContext null }
            val body =
                JSONObject().apply {
                    put("userId", userId)
                    if (tableId != null) put("tableId", tableId) else put("tableId", JSONObject.NULL)
                    put("x", position.x.toDouble())
                    put("y", position.y.toDouble())
                    if (zoneId != null) put("zone", zoneId) else put("zone", JSONObject.NULL)
                    put("zone_kind", zoneKind)
                }
            val request =
                Request.Builder()
                    .url("$base/v1/rooms/$room/state")
                    .header("Authorization", "Bearer $token")
                    .post(body.toString().toRequestBody(JSON))
                    .build()
            try {
                client.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) {
                        SyncleLog.w("state report http=${response.code}")
                    }
                    response.code
                }
            } catch (e: Exception) {
                SyncleLog.e("state report failed", e)
                null
            }
        }

    private companion object {
        val JSON = "application/json; charset=utf-8".toMediaType()
        val defaultClient: OkHttpClient =
            OkHttpClient.Builder()
                .connectTimeout(5, TimeUnit.SECONDS)
                .readTimeout(5, TimeUnit.SECONDS)
                .build()
    }
}
