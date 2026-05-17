import React from 'react';
import { Pie, Bar, Doughnut, Line } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  LineElement,
  PointElement,
  ArcElement,
  Title,
  Tooltip,
  Legend,
} from 'chart.js';

// Register ChartJS components
ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  LineElement,
  PointElement,
  ArcElement,
  Title,
  Tooltip,
  Legend
);

export default function ResultsVisualization({ results, examConfig }) {
  const { numberOfQuestions, marksPerQuestion, negativeMarks, totalMarks } = examConfig;

  // Calculate statistics
  const totalStudents = results.length;
  const passedStudents = results.filter(r => parseFloat(r.percentage) >= 40).length;
  const failedStudents = totalStudents - passedStudents;
  
  const averageScore = results.reduce((sum, r) => sum + parseFloat(r.percentage), 0) / totalStudents;
  const averageMarks = results.reduce((sum, r) => sum + r.marksObtained, 0) / totalStudents;
  
  const scoreRanges = {
    '90-100%': results.filter(r => parseFloat(r.percentage) >= 90).length,
    '80-89%': results.filter(r => parseFloat(r.percentage) >= 80 && parseFloat(r.percentage) < 90).length,
    '70-79%': results.filter(r => parseFloat(r.percentage) >= 70 && parseFloat(r.percentage) < 80).length,
    '60-69%': results.filter(r => parseFloat(r.percentage) >= 60 && parseFloat(r.percentage) < 70).length,
    '50-59%': results.filter(r => parseFloat(r.percentage) >= 50 && parseFloat(r.percentage) < 60).length,
    '40-49%': results.filter(r => parseFloat(r.percentage) >= 40 && parseFloat(r.percentage) < 50).length,
    'Below 40%': results.filter(r => parseFloat(r.percentage) < 40).length,
  };

  // Calculate question-wise performance
  const questionPerformance = Array.from({ length: numberOfQuestions }, (_, i) => {
    const correctAnswers = results.filter(r => r.picked[i] === examConfig.answerKey[i]).length;
    return {
      question: i + 1,
      correct: correctAnswers,
      incorrect: results.filter(r => r.picked[i] !== -1 && r.picked[i] !== examConfig.answerKey[i]).length,
      unanswered: results.filter(r => r.picked[i] === -1).length,
      accuracy: (correctAnswers / totalStudents) * 100
    };
  });

  // Chart data configurations
  const passFailData = {
    labels: ['Passed', 'Failed'],
    datasets: [
      {
        data: [passedStudents, failedStudents],
        backgroundColor: ['#4ade80', '#f87171'],
        borderColor: ['#16a34a', '#dc2626'],
        borderWidth: 2,
      },
    ],
  };

  const scoreDistributionData = {
    labels: Object.keys(scoreRanges),
    datasets: [
      {
        label: 'Number of Students',
        data: Object.values(scoreRanges),
        backgroundColor: [
          '#10b981', '#34d399', '#6ee7b7', '#a7f3d0', '#d1fae5', '#fef3c7', '#fbbf24'
        ],
        borderColor: [
          '#059669', '#10b981', '#34d399', '#6ee7b7', '#a7f3d0', '#f59e0b', '#d97706'
        ],
        borderWidth: 2,
      },
    ],
  };

  const questionAccuracyData = {
    labels: questionPerformance.map(q => `Q${q.question}`),
    datasets: [
      {
        label: 'Accuracy %',
        data: questionPerformance.map(q => q.accuracy),
        backgroundColor: 'rgba(59, 130, 246, 0.6)',
        borderColor: 'rgb(59, 130, 246)',
        borderWidth: 2,
      },
    ],
  };

  const marksDistributionData = {
    labels: results.map((r, i) => `Student ${i + 1}`),
    datasets: [
      {
        label: 'Marks Obtained',
        data: results.map(r => r.marksObtained),
        backgroundColor: 'rgba(139, 92, 246, 0.6)',
        borderColor: 'rgb(139, 92, 246)',
        borderWidth: 1,
      },
    ],
  };

  const chartOptions = {
    responsive: true,
    plugins: {
      legend: {
        position: 'top',
      },
      title: {
        display: true,
        text: 'Exam Results Analysis',
      },
    },
  };

  const barChartOptions = {
    ...chartOptions,
    scales: {
      y: {
        beginAtZero: true,
        max: 100,
        title: {
          display: true,
          text: 'Percentage (%)'
        }
      },
    },
  };

  return (
    <div className="space-y-8">
      {/* Summary Statistics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl p-4 border text-center">
          <div className="text-2xl font-bold text-blue-600">{totalStudents}</div>
          <div className="text-sm text-gray-600">Total Students</div>
        </div>
        <div className="bg-white rounded-xl p-4 border text-center">
          <div className="text-2xl font-bold text-green-600">{passedStudents}</div>
          <div className="text-sm text-gray-600">Passed</div>
        </div>
        <div className="bg-white rounded-xl p-4 border text-center">
          <div className="text-2xl font-bold text-red-600">{failedStudents}</div>
          <div className="text-sm text-gray-600">Failed</div>
        </div>
        <div className="bg-white rounded-xl p-4 border text-center">
          <div className="text-2xl font-bold text-purple-600">{averageScore.toFixed(1)}%</div>
          <div className="text-sm text-gray-600">Average Score</div>
        </div>
      </div>

      {/* Charts Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Pass/Fail Ratio */}
        <div className="bg-white rounded-xl p-6 border">
          <h3 className="text-lg font-semibold mb-4">Pass/Fail Ratio</h3>
          <div className="h-64">
            <Doughnut 
              data={passFailData} 
              options={{
                ...chartOptions,
                plugins: {
                  ...chartOptions.plugins,
                  title: {
                    display: true,
                    text: `Pass Rate: ${((passedStudents / totalStudents) * 100).toFixed(1)}%`
                  }
                }
              }} 
            />
          </div>
        </div>

        {/* Score Distribution */}
        <div className="bg-white rounded-xl p-6 border">
          <h3 className="text-lg font-semibold mb-4">Score Distribution</h3>
          <div className="h-64">
            <Bar data={scoreDistributionData} options={chartOptions} />
          </div>
        </div>

        {/* Question-wise Accuracy */}
        <div className="bg-white rounded-xl p-6 border">
          <h3 className="text-lg font-semibold mb-4">Question-wise Accuracy</h3>
          <div className="h-64">
            <Bar data={questionAccuracyData} options={barChartOptions} />
          </div>
        </div>

        {/* Marks Distribution */}
        <div className="bg-white rounded-xl p-6 border">
          <h3 className="text-lg font-semibold mb-4">Marks Distribution</h3>
          <div className="h-64">
            <Line 
              data={marksDistributionData} 
              options={{
                ...chartOptions,
                scales: {
                  x: {
                    display: false
                  },
                  y: {
                    beginAtZero: true,
                    title: {
                      display: true,
                      text: 'Marks'
                    }
                  }
                }
              }} 
            />
          </div>
        </div>
      </div>

      {/* Detailed Question Analysis */}
      <div className="bg-white rounded-xl p-6 border">
        <h3 className="text-lg font-semibold mb-4">Detailed Question Analysis</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50">
                <th className="px-4 py-2 text-left">Question</th>
                <th className="px-4 py-2 text-center">Correct</th>
                <th className="px-4 py-2 text-center">Incorrect</th>
                <th className="px-4 py-2 text-center">Unanswered</th>
                <th className="px-4 py-2 text-center">Accuracy</th>
                <th className="px-4 py-2 text-center">Difficulty</th>
              </tr>
            </thead>
            <tbody>
              {questionPerformance.map((q, index) => (
                <tr key={index} className="border-t">
                  <td className="px-4 py-2 font-medium">Question {q.question}</td>
                  <td className="px-4 py-2 text-center text-green-600">{q.correct}</td>
                  <td className="px-4 py-2 text-center text-red-600">{q.incorrect}</td>
                  <td className="px-4 py-2 text-center text-gray-600">{q.unanswered}</td>
                  <td className="px-4 py-2 text-center">{q.accuracy.toFixed(1)}%</td>
                  <td className="px-4 py-2 text-center">
                    <span className={`px-2 py-1 rounded-full text-xs ${
                      q.accuracy >= 70 ? 'bg-green-100 text-green-800' :
                      q.accuracy >= 40 ? 'bg-yellow-100 text-yellow-800' :
                      'bg-red-100 text-red-800'
                    }`}>
                      {q.accuracy >= 70 ? 'Easy' : q.accuracy >= 40 ? 'Medium' : 'Hard'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Performance Insights */}
      <div className="bg-white rounded-xl p-6 border">
        <h3 className="text-lg font-semibold mb-4">Performance Insights</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-3">
            <h4 className="font-medium text-blue-700">Top Performers</h4>
            {results
              .sort((a, b) => parseFloat(b.percentage) - parseFloat(a.percentage))
              .slice(0, 3)
              .map((student, index) => (
                <div key={index} className="flex justify-between items-center p-2 bg-blue-50 rounded">
                  <span className="font-medium">{student.name}</span>
                  <span className="text-green-600 font-bold">{student.percentage}%</span>
                </div>
              ))}
          </div>
          <div className="space-y-3">
            <h4 className="font-medium text-red-700">Need Improvement</h4>
            {results
              .sort((a, b) => parseFloat(a.percentage) - parseFloat(b.percentage))
              .slice(0, 3)
              .map((student, index) => (
                <div key={index} className="flex justify-between items-center p-2 bg-red-50 rounded">
                  <span className="font-medium">{student.name}</span>
                  <span className="text-red-600 font-bold">{student.percentage}%</span>
                </div>
              ))}
          </div>
        </div>
      </div>
    </div>
  );
}