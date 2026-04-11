"""
MongoDB Utilities for MTR Dashboard
Helper functions for querying time-series MTR data.
"""

import os
from datetime import datetime, timedelta
from typing import List, Dict, Any, Optional
from pymongo import MongoClient, ASCENDING, DESCENDING
from pymongo.errors import ConnectionFailure
import logging
from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class MTRMetricsQuery:
    """Query MTR metrics from MongoDB."""
    
    def __init__(self):
        self.uri = os.getenv('MONGODB_URI', 'mongodb://localhost:27017')
        self.database = os.getenv('MONGODB_DATABASE', 'mtr_metrics')
        self.collection_name = os.getenv('MONGODB_COLLECTION', 'mtr_results')
        self.client = None
        self.collection = None
        self.connect()
        
    def connect(self):
        """Establish MongoDB connection."""
        try:
            self.client = MongoClient(self.uri, serverSelectionTimeoutMS=5000)
            self.client.admin.command('ping')
            db = self.client[self.database]
            self.collection = db[self.collection_name]
            logger.info(f"Connected to MongoDB for querying")
            self._ensure_indexes()
        except ConnectionFailure as e:
            logger.error(f"MongoDB connection error: {e}")
            raise
    
    def _ensure_indexes(self):
        """Create indexes for efficient querying."""
        self.collection.create_index([('device_id', ASCENDING), ('timestamp', DESCENDING)])
        self.collection.create_index([('ip_address', ASCENDING)])
        self.collection.create_index([('timestamp', DESCENDING)])
        logger.debug("MongoDB indexes ensured")
    
    def disconnect(self):
        """Close MongoDB connection."""
        if self.client:
            self.client.close()
            logger.info("MongoDB query connection closed")
    
    def get_latest_results(self, device_id: Optional[int] = None, limit: int = 100) -> List[Dict[str, Any]]:
        """
        Get latest MTR results, optionally filtered by device_id.
        """
        query = {}
        if device_id is not None:
            query['device_id'] = device_id
        
        cursor = self.collection.find(query).sort('timestamp', DESCENDING).limit(limit)
        results = list(cursor)
        
        # Convert ObjectId to string for JSON serialization
        for doc in results:
            doc['_id'] = str(doc['_id'])
            if 'timestamp' in doc and isinstance(doc['timestamp'], datetime):
                doc['timestamp'] = doc['timestamp'].isoformat()
        
        return results
    
    def get_results_by_time_range(
        self, 
        device_id: int, 
        start_time: datetime, 
        end_time: datetime
    ) -> List[Dict[str, Any]]:
        """
        Get MTR results for a specific device within a time range.
        """
        query = {
            'device_id': device_id,
            'timestamp': {'$gte': start_time, '$lte': end_time}
        }
        
        cursor = self.collection.find(query).sort('timestamp', ASCENDING)
        results = list(cursor)
        
        for doc in results:
            doc['_id'] = str(doc['_id'])
            if 'timestamp' in doc and isinstance(doc['timestamp'], datetime):
                doc['timestamp'] = doc['timestamp'].isoformat()
        
        return results
    
    def get_devices_with_data(self) -> List[Dict[str, Any]]:
        """
        Get list of unique devices that have MTR data.
        Returns device info with latest result timestamp.
        """
        pipeline = [
            {
                '$group': {
                    '_id': '$device_id',
                    'ip_address': {'$first': '$ip_address'},
                    'hostname': {'$first': '$hostname'},
                    'latest_timestamp': {'$max': '$timestamp'},
                    'result_count': {'$sum': 1}
                }
            },
            {
                '$sort': {'latest_timestamp': -1}
            }
        ]
        
        results = list(self.collection.aggregate(pipeline))
        
        for doc in results:
            doc['_id'] = str(doc['_id'])
            if 'latest_timestamp' in doc and isinstance(doc['latest_timestamp'], datetime):
                doc['latest_timestamp'] = doc['latest_timestamp'].isoformat()
        
        return results
    
    def get_hop_statistics(self, device_id: int, hours: int = 24) -> Dict[str, Any]:
        """
        Get hop-level statistics for a device over time period.
        Calculates loss and latency metrics per hop.
        """
        start_time = datetime.utcnow() - timedelta(hours=hours)
        
        pipeline = [
            {
                '$match': {
                    'device_id': device_id,
                    'timestamp': {'$gte': start_time}
                }
            },
            {
                '$unwind': '$mtr_result.hubs'
            },
            {
                '$group': {
                    '_id': '$mtr_result.hubs.count',
                    'avg_loss': {'$avg': '$mtr_result.hubs.Loss'},
                    'avg_latency': {'$avg': '$mtr_result.hubs.Avg'},
                    'max_latency': {'$max': '$mtr_result.hubs.Best'},
                    'count': {'$sum': 1}
                }
            },
            {
                '$sort': {'_id': 1}
            }
        ]
        
        results = list(self.collection.aggregate(pipeline))
        
        return {
            'device_id': device_id,
            'time_range_hours': hours,
            'hops': results
        }
    
    def delete_old_results(self, days: int = 30) -> int:
        """
        Delete MTR results older than specified days.
        Useful for cleanup and storage management.
        
        :param days: Number of days to retain
        :return: Number of deleted documents
        """
        cutoff_time = datetime.utcnow() - timedelta(days=days)
        result = self.collection.delete_many({'timestamp': {'$lt': cutoff_time}})
        logger.info(f"Deleted {result.deleted_count} MTR results older than {days} days")
        return result.deleted_count
        Get distinct devices that have MTR data in MongoDB.
        Returns list of dicts with device_id, ip_address, hostname, and latest timestamp.
        """
        pipeline = [
            {
                '$group': {
                    '_id': '$device_id',
                    'ip_address': {'$first': '$ip_address'},
                    'hostname': {'$first': '$hostname'},
                    'latest_timestamp': {'$max': '$timestamp'},
                    'count': {'$sum': 1}
                }
            },
            {'$sort': {'latest_timestamp': DESCENDING}}
        ]
        
        results = list(self.collection.aggregate(pipeline))
        
        # Format output
        formatted = []
        for r in results:
            formatted.append({
                'device_id': r['_id'],
                'ip_address': r['ip_address'],
                'hostname': r['hostname'],
                'latest_timestamp': r['latest_timestamp'].isoformat() if isinstance(r['latest_timestamp'], datetime) else r['latest_timestamp'],
                'record_count': r['count']
            })
        
        return formatted
    
    def get_hops_statistics(self, device_id: int, hours: int = 24) -> Dict[str, Any]:
        """
        Calculate statistics for hops over the last N hours.
        """
        end_time = datetime.now()
        start_time = end_time - timedelta(hours=hours)
        
        results = self.get_results_by_time_range(device_id, start_time, end_time)
        
        if not results:
            return {'device_id': device_id, 'hours': hours, 'statistics': {}}
        
        hop_counts = []
        avg_latencies = []
        
        for doc in results:
            mtr_result = doc.get('mtr_result', {})
            hubs = mtr_result.get('hubs', [])
            hop_counts.append(len(hubs))
            
            # Calculate average latency across hops
            latencies = []
            for hub in hubs:
                if 'avg' in hub:
                    latencies.append(hub['avg'])
            if latencies:
                avg_latencies.append(sum(latencies) / len(latencies))
        
        stats = {
            'device_id': device_id,
            'hours': hours,
            'total_samples': len(results),
            'hops': {
                'min': min(hop_counts) if hop_counts else 0,
                'max': max(hop_counts) if hop_counts else 0,
                'avg': sum(hop_counts) / len(hop_counts) if hop_counts else 0,
                'std': None  # Could calculate if needed
            },
            'latency': {
                'min': min(avg_latencies) if avg_latencies else 0,
                'max': max(avg_latencies) if avg_latencies else 0,
                'avg': sum(avg_latencies) / len(avg_latencies) if avg_latencies else 0
            }
        }
        
        return stats
    
    def delete_old_data(self, days_old: int = 30) -> int:
        """
        Delete MTR records older than specified days.
        Returns number of deleted documents.
        """
        cutoff_date = datetime.now() - timedelta(days=days_old)
        result = self.collection.delete_many({'timestamp': {'$lt': cutoff_date}})
        logger.info(f"Deleted {result.deleted_count} records older than {days_old} days")
        return result.deleted_count

# Example usage
if __name__ == "__main__":
    query = MTRMetricsQuery()
    
    # Get devices with data
    devices = query.get_devices_with_data()
    print(f"Devices with data: {len(devices)}")
    for d in devices[:3]:
        print(f"  - {d['hostname']} ({d['ip_address']}): {d['record_count']} records")
    
    # Get latest results
    if devices:
        latest = query.get_latest_results(device_id=devices[0]['device_id'], limit=5)
        print(f"\nLatest 5 results for device {devices[0]['device_id']}:")
        for r in latest:
            print(f"  - {r['timestamp']}: {len(r['mtr_result'].get('hubs', []))} hops")
    
    # Get statistics
    if devices:
        stats = query.get_hops_statistics(devices[0]['device_id'], hours=24)
        print(f"\n24-hour statistics:")
        print(f"  Hops: min={stats['hops']['min']}, max={stats['hops']['max']}, avg={stats['hops']['avg']:.2f}")
        print(f"  Latency: min={stats['latency']['min']:.2f}ms, max={stats['latency']['max']:.2f}ms, avg={stats['latency']['avg']:.2f}ms")
    
    query.disconnect()